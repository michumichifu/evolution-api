/**
 * 🔴 PARCHE PD (8 oct 2026): QUÉ HACER CUANDO PIDEN UN QR O UN CÓDIGO DE EMPAREJAMIENTO.
 *
 * La noche del 7 al 8 de octubre de 2026 vincular un número (Dento Estetic, el de Viki) costó 67
 * minutos y diez intentos. Tres fallos de este backend, los tres aquí:
 *
 *  1. Con un QR abierto, pedir el código alfanumérico devolvía el QR en curso y `pairingCode: null`:
 *     el Manager se quedaba con la rueda girando. `connectToWhatsapp` del controlador, con el estado
 *     en `connecting`, no miraba el `number`.
 *  2. La respuesta de `/instance/connect` traía el código o el QR de la generación ANTERIOR mientras
 *     la nueva no hubiera producido el suyo (se entregó a una clienta un código de cinco minutos).
 *  3. «Reiniciar» durante una generación no la cortaba: cerraba el socket y volvía a abrir otro en
 *     modo QR.
 *
 * (El cuarto, el peor —`isDeleting` no volvía a `false` tras un `logout` y la vinculación se
 * aceptaba en el teléfono sin completarse aquí—, se arregla en `createClient`.)
 *
 * Este archivo es solo la DECISIÓN, sin socket ni base, para poder probarla:
 *   npx tsx --test pruebas-pd/vinculacion.test.ts
 *
 * Luis: «si yo genero o intento crear otra generación por otro tipo, pues debe cerrarse la anterior.
 * Para que no quede eso cargando… Al igual que si le doy reiniciar… debería cortar esa generación».
 */

export type EstadoConexion = 'open' | 'connecting' | 'close' | string | undefined;

export type PeticionVinculacion = {
  /** `connectionStatus.state` de la instancia en memoria. */
  estado: EstadoConexion;
  /** Hay una generación de QR o de código en curso (socket abierto y sin sesión iniciada). */
  enVinculacion: boolean;
  /** El número con el que se abrió la generación en curso; vacío si es por QR. */
  numeroActual?: string | null;
  /** El número que trae la petición; vacío si piden QR. */
  numeroPedido?: string | null;
};

export type AccionVinculacion =
  /** No existe la instancia en memoria. */
  | 'no-existe'
  /** Ya está conectada: se devuelve el estado. */
  | 'conectada'
  /** Hay una generación del MISMO tipo: se devuelve lo que hay, sin tocar el socket. */
  | 'devolver'
  /** Hay una generación del OTRO tipo (o con otro número): se cierra y se abre la pedida. */
  | 'cambiar'
  /** Está cerrada: se abre una generación nueva. */
  | 'abrir';

/** Solo dígitos: `+1 (809) 555-1234` y `18095551234` son el mismo número. */
export function soloDigitos(numero?: string | null): string {
  return String(numero ?? '').replace(/\D/g, '');
}

export function decidirVinculacion(p: PeticionVinculacion): AccionVinculacion {
  if (!p.estado) return 'no-existe';
  if (p.estado === 'open') return 'conectada';

  if (p.estado === 'connecting') {
    // Una instancia YA vinculada que está reconectando también pasa por `connecting`: ahí no hay
    // generación que cambiar y abrir otro socket sería el bucle 440 de siempre.
    if (!p.enVinculacion) return 'devolver';
    return soloDigitos(p.numeroPedido) === soloDigitos(p.numeroActual) ? 'devolver' : 'cambiar';
  }

  return 'abrir';
}

/** ¿«Reiniciar» tiene que cortar una generación en vez de reabrir el socket? */
export function reiniciarCortaLaGeneracion(estado: EstadoConexion, enVinculacion: boolean): boolean {
  return estado === 'connecting' && enVinculacion;
}

/**
 * ¿La respuesta ya trae lo que se pidió? Con número hace falta el código alfanumérico; sin número,
 * el QR. Sirve para no contestar con los restos de la generación anterior.
 */
export function generacionLista(
  qr: { code?: string | null; pairingCode?: string | null } | null | undefined,
  conNumero: boolean,
): boolean {
  if (!qr?.code) return false;
  return conNumero ? !!qr.pairingCode : true;
}

/**
 * PD 2026-10-07 (José Luis, portado del `main.js` del servidor el 8 oct): en una instancia Cloud API
 * la «apikey» de la instancia ES el token de Meta (empieza por `EAA`). El sobre del webhook la
 * llevaba en `apikey` y n8n la guardaba en cada ejecución. Si es un token de Meta, no se envía; las
 * instancias por QR la siguen enviando, porque el flujo de Luisa la usa.
 */
export function esTokenDeMeta(apikey?: string | null): boolean {
  return /^EAA/.test(String(apikey ?? ''));
}
