/**
 * 🔴 PARCHE PD (3 oct 2026): EL ESTADO REAL DE UN NÚMERO DE CLOUD API, SEGÚN META.
 *
 * Una instancia `WHATSAPP-BUSINESS` no tiene socket: `BusinessStartupService.stateConnection` es
 * `{ state: 'open' }` fijo, así que el Manager la enseñaba «Conectado» SIEMPRE. El 30 sep 2026 a
 * las 23:18 RD el número de «Zenithe 2 - Cloud Api» quedó «Fuera de internet» en el Business Manager
 * y la app perdió el acceso (Graph: `GraphMethodException`, code 100, subcode 33), y nadie se enteró
 * en dos días. Luis: «tiene que indicar realmente que esa instancia está desconectada».
 *
 * Este archivo es solo la CONSULTA y su lectura (sin base, sin Prisma, sin estado), para poder
 * probarla con Graph simulado. El servicio que la programa y guarda el resultado está en
 * `salud-meta.service.ts`.
 *
 * 🔴 Un fallo de red, un timeout, un 5xx o un límite de llamadas NO es «desconectado»: es «sin
 * comprobar», y el último resultado bueno se conserva.
 */

/** Los campos que se le piden a Meta del número. */
export const CAMPOS_SALUD_META = 'status,display_phone_number,verified_name,quality_rating,name_status,new_name_status';

/** Lo que significa el resultado de una consulta. */
export type TipoResultadoMeta =
  | 'ok' // Meta contestó con los datos del número (su `status` puede ser bueno o malo)
  | 'sin_acceso' // Meta contestó que la app no puede ver el número (code 100/33, permisos)
  | 'token_invalido' // code 190
  | 'error_graph' // Meta contestó un error que no es de acceso ni pasajero: no se concluye nada
  | 'sin_comprobar'; // red, timeout, 5xx o límite: no hubo respuesta útil

export interface ErrorGraph {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export interface ResultadoSaludMeta {
  tipo: TipoResultadoMeta;
  /**
   * El `status` de Meta (`CONNECTED`, `DISCONNECTED`, `FLAGGED`…) si `tipo` es `ok`;
   * `NO_ACCESS` o `TOKEN_INVALID` si Meta lo negó; `null` si no se pudo saber.
   */
  metaStatus: string | null;
  displayPhone?: string | null;
  verifiedName?: string | null;
  qualityRating?: string | null;
  nameStatus?: string | null;
  newNameStatus?: string | null;
  profilePicUrl?: string | null;
  /** El error tal cual lo dio Graph (o la red), para enseñarlo y para el log. */
  error?: string | null;
  httpStatus?: number | null;
}

export interface OpcionesConsultaMeta {
  base: string; // WA_BUSINESS.URL, p. ej. https://graph.facebook.com
  version: string; // WA_BUSINESS.VERSION, p. ej. v20.0
  number: string; // el phone_number_id
  token: string;
  timeoutMs?: number;
  /** Para las pruebas: un `fetch` simulado. */
  fetchImpl?: typeof fetch;
}

/** Códigos de Graph que son pasajeros: límite de llamadas o fallo interno de Meta. */
const CODIGOS_PASAJEROS = new Set([1, 2, 4, 17, 32, 341, 368, 613, 80007, 130429, 131016]);

function textoError(e: ErrorGraph | undefined, httpStatus: number | null): string {
  if (!e) return `Graph ${httpStatus ?? '?'}`;
  const partes = [
    e.type,
    e.code != null ? `code ${e.code}` : null,
    e.error_subcode != null ? `subcode ${e.error_subcode}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return `${e.message ?? 'error de Graph'}${partes ? ` (${partes})` : ''}`;
}

/** Lee un error de Graph y dice qué significa. Separado para poder probarlo solo. */
export function clasificarErrorGraph(e: ErrorGraph | undefined, httpStatus: number | null): ResultadoSaludMeta {
  const error = textoError(e, httpStatus);
  const code = e?.code;
  if (code === 190) return { tipo: 'token_invalido', metaStatus: 'TOKEN_INVALID', error, httpStatus };
  if (
    (code === 100 && e?.error_subcode === 33) || // «Object with ID … does not exist, cannot be loaded due to missing permissions»
    code === 10 || // permiso denegado
    (code >= 200 && code <= 299) // permisos de la app
  ) {
    return { tipo: 'sin_acceso', metaStatus: 'NO_ACCESS', error, httpStatus };
  }
  if ((code != null && CODIGOS_PASAJEROS.has(code)) || (httpStatus != null && httpStatus >= 500) || !e) {
    return { tipo: 'sin_comprobar', metaStatus: null, error, httpStatus };
  }
  return { tipo: 'error_graph', metaStatus: null, error, httpStatus };
}

async function pedirJson(
  url: string,
  token: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Le pregunta a Meta por un número. NUNCA lanza: todo fallo vuelve como un resultado.
 * Si el número contesta, pide también la foto de perfil (si eso falla, la foto queda vacía y
 * el estado no cambia).
 */
export async function consultarSaludMeta(op: OpcionesConsultaMeta): Promise<ResultadoSaludMeta> {
  const fetchImpl = op.fetchImpl ?? fetch;
  const timeoutMs = op.timeoutMs ?? 15000;
  if (!op.number || !op.token) {
    return { tipo: 'sin_comprobar', metaStatus: null, error: 'La instancia no tiene phone_number_id o token' };
  }
  const raiz = `${String(op.base).replace(/\/+$/, '')}/${op.version}/${encodeURIComponent(op.number)}`;

  let info: { ok: boolean; status: number; body: any };
  try {
    info = await pedirJson(`${raiz}?fields=${CAMPOS_SALUD_META}`, op.token, timeoutMs, fetchImpl);
  } catch (err) {
    // timeout (AbortError/TimeoutError), DNS, conexión rechazada…: no hubo respuesta
    return {
      tipo: 'sin_comprobar',
      metaStatus: null,
      error: `Sin respuesta de Meta: ${err?.name ?? ''} ${err?.message ?? err}`.trim(),
    };
  }

  if (!info.ok || info.body?.error) {
    return clasificarErrorGraph(info.body?.error, info.status);
  }

  const b = info.body ?? {};
  const resultado: ResultadoSaludMeta = {
    tipo: 'ok',
    metaStatus: typeof b.status === 'string' && b.status ? b.status.toUpperCase() : 'UNKNOWN',
    displayPhone: b.display_phone_number ?? null,
    verifiedName: b.verified_name ?? null,
    qualityRating: b.quality_rating ?? null,
    nameStatus: b.name_status ?? null,
    newNameStatus: b.new_name_status ?? null,
    profilePicUrl: null,
    error: null,
    httpStatus: info.status,
  };

  try {
    const foto = await pedirJson(
      `${raiz}/whatsapp_business_profile?fields=profile_picture_url`,
      op.token,
      timeoutMs,
      fetchImpl,
    );
    if (foto.ok) resultado.profilePicUrl = foto.body?.data?.[0]?.profile_picture_url ?? null;
  } catch {
    // la foto es un extra: sin ella el estado sigue siendo válido
  }

  return resultado;
}

/**
 * Estados de Meta con los que el número SIGUE enviando y recibiendo: se avisa, pero no se marca
 * «Desconectado». FLAGGED = calidad baja; RATE_LIMITED = frenado por envíos; UNKNOWN = Meta no
 * dijo nada concluyente.
 */
const ESTADOS_QUE_FUNCIONAN = new Set(['CONNECTED', 'FLAGGED', 'RATE_LIMITED', 'UNKNOWN']);

/** ¿Este `metaStatus` guardado quiere decir que el número NO funciona? `null` = no se sabe. */
export function metaDesconectado(metaStatus: string | null | undefined): boolean {
  if (!metaStatus) return false; // sin comprobar no es desconectado
  return !ESTADOS_QUE_FUNCIONAN.has(metaStatus);
}

/** El motivo en español, para enseñarlo debajo del estado. `null` si no hay nada que decir. */
export function motivoMeta(metaStatus: string | null | undefined, errorIntento?: string | null): string | null {
  switch (metaStatus) {
    case 'CONNECTED':
      return null;
    case 'NO_ACCESS':
      return 'Meta: sin acceso al número (¿coexistencia sin actividad o permiso retirado?)';
    case 'TOKEN_INVALID':
      return 'Meta: token inválido o caducado';
    case 'DISCONNECTED':
    case 'OFFLINE':
      return 'Meta: número fuera de internet';
    case 'BANNED':
      return 'Meta: número bloqueado';
    case 'RESTRICTED':
      return 'Meta: número restringido (no puede escribir a clientes nuevos)';
    case 'DELETED':
      return 'Meta: número eliminado';
    case 'MIGRATED':
      return 'Meta: número migrado a otra cuenta';
    case 'PENDING':
      return 'Meta: número pendiente de registro';
    case 'UNVERIFIED':
      return 'Meta: número sin verificar';
    case 'FLAGGED':
      return 'Meta: calidad baja (número marcado, sigue funcionando)';
    case 'RATE_LIMITED':
      return 'Meta: envíos limitados por Meta';
    case 'UNKNOWN':
      return 'Meta no informó el estado del número';
    case null:
    case undefined:
    case '':
      return errorIntento ? 'Meta: sin comprobar (no respondió)' : null;
    default:
      return `Meta: estado ${metaStatus}`;
  }
}
