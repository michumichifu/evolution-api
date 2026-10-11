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
