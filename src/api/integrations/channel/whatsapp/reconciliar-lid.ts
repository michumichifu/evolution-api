/**
 * PARCHE PD (10 oct 2026): LO YA GUARDADO CON `@lid` SE CORRIGE CUANDO SE APRENDE SU TELÉFONO.
 *
 * `resolverTelefonoDeLid` (10 sep) cambia el `@lid` por el teléfono AL LLEGAR el mensaje, y solo
 * si Baileys conoce el par en ese instante. El par llega muchas veces DESPUÉS: con el historial de
 * una vinculación (los mensajes entran antes que el mapa), cuando la clínica contesta, o cuando
 * `/chat/whatsappNumbers` lo pide con el teléfono de un registro. Nada volvía atrás, y lo guardado
 * se quedaba para siempre como un «número» de 15 cifras, casi siempre en un chat aparte del que
 * la misma persona ya tenía con su teléfono. Medido ese día: 2.049 mensajes de 308 chats con su
 * par conocido, 140 de ellos en Dental Shine (136 con el chat partido en dos).
 *
 * Esto es la vuelta atrás: se listan los `@lid` guardados, se pregunta por su par SOLO en los
 * mapas locales (nunca a WhatsApp) y se pasan sus mensajes al teléfono. Sin socket y sin base
 * aquí dentro, para poder probarlo: quien llama pone las tres piezas.
 */
export type PiezasDeReconciliar = {
  /** Los `<id>@lid` que esta instancia tiene guardados como `remoteJid`. */
  lidsGuardados: () => Promise<string[]>;
  /** El teléfono (`<n>@s.whatsapp.net`) de un `@lid`, o nada si no se conoce. No pregunta a WhatsApp. */
  telefonoDe: (lid: string) => Promise<string | undefined | null>;
  /** Pasa al teléfono los mensajes guardados con ese `@lid`. Devuelve cuántos tocó. */
  mover: (lid: string, telefono: string) => Promise<number>;
  avisar?: (texto: string) => void;
};

export type ResultadoDeReconciliar = { revisados: number; chats: number; mensajes: number; fallidos: number };

const esLid = (jid: unknown): jid is string => typeof jid === 'string' && /^\d+@lid$/.test(jid);
const esTelefono = (jid: unknown): jid is string => typeof jid === 'string' && /^\d{8,15}@s\.whatsapp\.net$/.test(jid);

export async function reconciliarLidsGuardados(piezas: PiezasDeReconciliar): Promise<ResultadoDeReconciliar> {
  const resultado: ResultadoDeReconciliar = { revisados: 0, chats: 0, mensajes: 0, fallidos: 0 };

  for (const lid of await piezas.lidsGuardados()) {
    if (!esLid(lid)) continue;
    resultado.revisados++;
    try {
      const telefono = await piezas.telefonoDe(lid);
      // Quien oculta de verdad su número no tiene par: se queda como está, con su usuario.
      if (!esTelefono(telefono)) continue;
      const tocados = await piezas.mover(lid, telefono);
      if (tocados > 0) {
        resultado.chats++;
        resultado.mensajes += tocados;
      }
    } catch (error) {
      // Un chat que falla no puede dejar sin corregir a los demás.
      resultado.fallidos++;
      piezas.avisar?.(`No se pudo pasar ${lid} a su telefono: ${(error as Error)?.message}`);
    }
  }

  return resultado;
}

/**
 * PARCHE PD (11 oct 2026): EL HISTORIAL DE UNA VINCULACIÓN TRAE EL TELÉFONO DE CADA CHAT, Y SE TIRABA.
 *
 * Baileys entrega cada conversación del historial como un contacto con `id`, `lid` y `phoneNumber`
 * (`Utils/history.js`: `lid: chat.lidJid`, `phoneNumber: chat.pnJid`), pero la rc.9 no guarda ese
 * par en su mapa y aquí solo se leía `id`. Un chat que llegaba direccionado por su `@lid` se
 * guardaba como un «número» de 15 cifras con el teléfono delante. Pasó al vincular Dento Estetic
 * el 8 oct: 35 chats así, y de 9 ya no se pudo recuperar nada porque esa cuenta salió de WhatsApp.
 *
 * Devuelve los pares que hay que guardar en el mapa ANTES de procesar los mensajes del lote.
 */
export function paresDelHistorial(
  contactos: Array<{ id?: string | null; lid?: string | null; phoneNumber?: string | null }> | null | undefined,
): Array<{ lid: string; pn: string }> {
  const pares = new Map<string, string>();
  const lidDe = (jid: unknown) => (typeof jid === 'string' && /^\d+(:\d+)?@lid$/.test(jid) ? jid : undefined);
  const pnDe = (jid: unknown) =>
    typeof jid === 'string' && /^\d{8,15}(:\d+)?@s\.whatsapp\.net$/.test(jid) ? jid : undefined;

  for (const contacto of contactos ?? []) {
    const lid = lidDe(contacto?.id) ?? lidDe(contacto?.lid);
    const pn = pnDe(contacto?.id) ?? pnDe(contacto?.phoneNumber);
    if (lid && pn) pares.set(lid, pn);
  }

  return [...pares].map(([lid, pn]) => ({ lid, pn }));
}
