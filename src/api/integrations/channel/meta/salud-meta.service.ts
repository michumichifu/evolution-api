/**
 * 🔴 PARCHE PD (3 oct 2026): el chequeo periódico del estado de cada número de Cloud API en Meta.
 * La consulta y su lectura están en `salud-meta.ts`; aquí se programa y se guarda.
 *
 * 🔴 DOS TRAMPAS QUE ESTE SERVICIO ESQUIVA A PROPÓSITO (no las «arregles»):
 *
 * 1. NO escribe en `Instance.connectionStatus` ni toca `stateConnection`. Al arrancar,
 *    `WAMonitoringService.setInstance` solo auto-conecta las instancias guardadas como
 *    'open'/'connecting'; una Cloud API guardada 'close' no se cargaría tras un reinicio y los
 *    webhooks de Meta se perderían el día que el número vuelva. Y `delInstanceTime` borra la
 *    instancia que no esté 'open' en memoria pasado `DEL_INSTANCE`. Por eso el estado de Meta vive
 *    APARTE (memoria + un archivo) y solo se aplica a la RESPUESTA de `fetchInstances`.
 *
 * 2. NO añade columnas a la base. El contenedor regenera el cliente de Prisma con el esquema DE LA
 *    IMAGEN oficial (`deploy_database.sh` → `db:generate`), no con el de este repo: una columna nueva
 *    haría fallar en producción toda consulta que la nombre. Se guarda en
 *    `INSTANCE_DIR/pd-salud-meta.json`, que sobrevive a `docker restart`.
 */
import { PrismaRepository } from '@api/repository/repository.service';
import { Integration } from '@api/types/wa.types';
import { ConfigService, Database, WaBusiness } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { INSTANCE_DIR } from '@config/path.config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

import {
  codigoMeta,
  consultarSaludMeta,
  ErrorGraphCompleto,
  metaDesconectado,
  motivoMeta,
  ResultadoSaludMeta,
  resumenAvisoCuenta,
} from './salud-meta';

/**
 * Una entrada del historial de una instancia: un cambio de estado visto en un chequeo, o un aviso
 * de cuenta que mandó Meta por webhook. La más nueva va primero; se guardan las últimas 30.
 */
export type EntradaHistorialMeta =
  | {
      tipo: 'estado';
      at: string;
      de: string | null;
      a: string | null;
      codigoDe: string | null;
      codigoA: string | null;
      error: string | null;
    }
  | {
      tipo: 'aviso';
      at: string;
      /** `entry.time` del webhook (cuándo lo generó Meta), en ISO. */
      metaAt: string | null;
      field: string;
      wabaId: string | null;
      resumen: string;
      /** El `value` del webhook tal cual (cortado a ~4 KB si fuera enorme). */
      value: unknown;
    };

const MAX_HISTORIAL = 30;

export interface EstadoMetaInstancia {
  instanceId: string;
  instanceName: string;
  number: string | null;
  /** CONNECTED, DISCONNECTED, FLAGGED… / NO_ACCESS / TOKEN_INVALID / null = nunca se pudo comprobar */
  metaStatus: string | null;
  /** Cuándo dio Meta la última respuesta CONCLUYENTE (la que fija `metaStatus`). */
  metaCheckedAt: string | null;
  /** El error de Graph de esa respuesta concluyente (NO_ACCESS, TOKEN_INVALID). */
  metaError: string | null;
  displayPhone: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  nameStatus: string | null;
  newNameStatus: string | null;
  profilePicUrl: string | null;
  /** El último intento, aunque no fuera concluyente. */
  metaAttemptAt: string | null;
  /** Si el último intento no fue concluyente (red, timeout, 5xx…), por qué. */
  metaAttemptError: string | null;
  /** El error de Graph de la última respuesta concluyente, con code/subcode/type/message/fbtrace_id. */
  metaGraphError: ErrorGraphCompleto | null;
  /**
   * El PRIMER chequeo que lo vio caído en esta racha (se borra cuando vuelve). 🔴 Es cuándo lo
   * vimos nosotros, no cuándo cayó: entre dos chequeos pasan hasta 30 min, y antes del despliegue
   * no había chequeo.
   */
  metaFailingSince: string | null;
  /** La última vez que Meta dijo que el número funcionaba. */
  metaLastOkAt: string | null;
  metaHistorial: EntradaHistorialMeta[];
}

type FilaInstancia = { id: string; name: string; number: string | null; token: string | null };
type FilaConWaba = FilaInstancia & { businessId: string | null };

/** Un aviso de cuenta que no casó con ninguna instancia (otro WABA, o la instancia ya no existe). */
type AvisoSinInstancia = Extract<EntradaHistorialMeta, { tipo: 'aviso' }>;

const ARCHIVO = 'pd-salud-meta.json';

export class SaludMetaService {
  private readonly logger = new Logger('SaludMeta');
  private readonly estados = new Map<string, EstadoMetaInstancia>();
  private avisosSinInstancia: AvisoSinInstancia[] = [];
  private readonly ultimoChequeoPorAviso = new Map<string, number>();
  private enCurso: Promise<EstadoMetaInstancia[]> | null = null;
  private temporizadores: NodeJS.Timeout[] = [];

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
    /** Para las pruebas: dónde se guarda el archivo y con qué se consulta. */
    private readonly opciones: {
      dir?: string;
      consultar?: typeof consultarSaludMeta;
      ahora?: () => Date;
    } = {},
  ) {
    this.cargarArchivo();
  }

  private get rutaArchivo() {
    return join(this.opciones.dir ?? INSTANCE_DIR, ARCHIVO);
  }

  private ahora() {
    return (this.opciones.ahora ?? (() => new Date()))().toISOString();
  }

  private cargarArchivo() {
    try {
      if (!existsSync(this.rutaArchivo)) return;
      const datos = JSON.parse(readFileSync(this.rutaArchivo, 'utf8'));
      for (const e of Object.values<EstadoMetaInstancia>(datos?.instancias ?? {})) {
        if (e?.instanceId)
          this.estados.set(e.instanceId, { ...this.vacio(e), ...e, metaHistorial: e.metaHistorial ?? [] });
      }
      this.avisosSinInstancia = Array.isArray(datos?.avisosSinInstancia) ? datos.avisosSinInstancia : [];
    } catch (error) {
      this.logger.warn(`No se pudo leer ${this.rutaArchivo}: ${error?.message ?? error}`);
    }
  }

  private vacio(fila: { instanceId: string; instanceName: string; number: string | null }): EstadoMetaInstancia {
    return {
      instanceId: fila.instanceId,
      instanceName: fila.instanceName,
      number: fila.number ?? null,
      metaStatus: null,
      metaCheckedAt: null,
      metaError: null,
      displayPhone: null,
      verifiedName: null,
      qualityRating: null,
      nameStatus: null,
      newNameStatus: null,
      profilePicUrl: null,
      metaAttemptAt: null,
      metaAttemptError: null,
      metaGraphError: null,
      metaFailingSince: null,
      metaLastOkAt: null,
      metaHistorial: [],
    };
  }

  /** Escribe el archivo con lo que hay en memoria. */
  public persistir() {
    try {
      const dir = this.opciones.dir ?? INSTANCE_DIR;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.rutaArchivo}.tmp`;
      const datos = {
        version: 1,
        instancias: Object.fromEntries(this.estados),
        avisosSinInstancia: this.avisosSinInstancia,
      };
      writeFileSync(tmp, JSON.stringify(datos, null, 2));
      renameSync(tmp, this.rutaArchivo);
    } catch (error) {
      // Sin archivo solo se pierde el último estado al reiniciar: el chequeo de arranque lo repone.
      this.logger.warn(`No se pudo guardar ${this.rutaArchivo}: ${error?.message ?? error}`);
    }
  }

  /** Arranca el chequeo: uno a los 20 s y luego cada `PD_SALUD_META_MINUTOS` (30 por defecto; 0 lo apaga). */
  public iniciar() {
    const minutos = Number.parseInt(process.env.PD_SALUD_META_MINUTOS ?? '30', 10);
    if (!Number.isFinite(minutos) || minutos <= 0) {
      this.logger.info('Chequeo del estado de Meta apagado (PD_SALUD_META_MINUTOS=0)');
      return;
    }
    const primero = setTimeout(() => this.comprobar().catch(() => undefined), 20_000);
    const periodico = setInterval(() => this.comprobar().catch(() => undefined), minutos * 60_000);
    primero.unref?.();
    periodico.unref?.();
    this.temporizadores.push(primero, periodico);
    this.logger.info(`Chequeo del estado de Meta de las instancias Cloud API cada ${minutos} min`);
  }

  public detener() {
    this.temporizadores.forEach((t) => clearTimeout(t));
    this.temporizadores = [];
  }

  /** El último estado conocido de una instancia (por id), si su número no ha cambiado. */
  public estadoDe(instanceId: string, number?: string | null): EstadoMetaInstancia | null {
    const e = this.estados.get(instanceId);
    if (!e) return null;
    if (number !== undefined && (e.number ?? null) !== (number ?? null)) return null; // otro número: dato viejo
    return e;
  }

  /**
   * Comprueba en Meta las instancias Cloud API (todas, o las de `instanceNames`). Si ya hay un
   * chequeo de todas en marcha, se espera a ese en vez de duplicar las llamadas.
   */
  public async comprobar(instanceNames?: string[]): Promise<EstadoMetaInstancia[]> {
    if (!instanceNames?.length && this.enCurso) return this.enCurso;
    const tarea = this.comprobarAhora(instanceNames);
    if (!instanceNames?.length) {
      this.enCurso = tarea;
      tarea
        .finally(() => {
          if (this.enCurso === tarea) this.enCurso = null;
        })
        .catch(() => undefined); // el error lo recibe quien espera `tarea`, no esta rama
    }
    return tarea;
  }

  private async comprobarAhora(instanceNames?: string[]): Promise<EstadoMetaInstancia[]> {
    const clientName = this.configService.get<Database>('DATABASE')?.CONNECTION?.CLIENT_NAME;
    const filas: FilaInstancia[] = await this.prismaRepository.instance.findMany({
      where: {
        integration: Integration.WHATSAPP_BUSINESS,
        ...(clientName ? { clientName } : {}),
        ...(instanceNames?.length ? { name: { in: instanceNames } } : {}),
      },
      select: { id: true, name: true, number: true, token: true },
    });

    const salida: EstadoMetaInstancia[] = [];
    for (const fila of filas) {
      salida.push(await this.comprobarInstancia(fila));
    }
    this.persistir();
    return salida;
  }

  /** Comprueba una instancia y guarda en memoria (el archivo lo escribe quien llama). */
  public async comprobarInstancia(fila: FilaInstancia): Promise<EstadoMetaInstancia> {
    const { URL: base, VERSION } = this.configService.get<WaBusiness>('WA_BUSINESS');
    const consultar = this.opciones.consultar ?? consultarSaludMeta;
    let r: ResultadoSaludMeta;
    try {
      r = await consultar({ base, version: VERSION, number: fila.number, token: fila.token });
    } catch (error) {
      r = { tipo: 'sin_comprobar', metaStatus: null, error: String(error?.message ?? error) };
    }
    return this.registrar(fila, r);
  }

  private registrar(fila: FilaInstancia, r: ResultadoSaludMeta): EstadoMetaInstancia {
    const antes = this.estadoDe(fila.id, fila.number);
    const ahora = this.ahora();
    const base: EstadoMetaInstancia = antes
      ? { ...antes, instanceName: fila.name }
      : this.vacio({ instanceId: fila.id, instanceName: fila.name, number: fila.number });

    let nuevo: EstadoMetaInstancia;
    if (r.tipo === 'ok') {
      nuevo = {
        ...base,
        metaStatus: r.metaStatus,
        metaCheckedAt: ahora,
        metaError: null,
        metaGraphError: null,
        displayPhone: r.displayPhone ?? base.displayPhone,
        verifiedName: r.verifiedName ?? base.verifiedName,
        qualityRating: r.qualityRating ?? null,
        nameStatus: r.nameStatus ?? null,
        newNameStatus: r.newNameStatus ?? null,
        profilePicUrl: r.profilePicUrl ?? base.profilePicUrl,
        metaAttemptAt: ahora,
        metaAttemptError: null,
      };
    } else if (r.tipo === 'sin_acceso' || r.tipo === 'token_invalido') {
      // Concluyente: Meta contestó, y contestó que no. El número visible se conserva.
      nuevo = {
        ...base,
        metaStatus: r.metaStatus,
        metaCheckedAt: ahora,
        metaError: r.error ?? null,
        metaGraphError: r.graphError ?? null,
        metaAttemptAt: ahora,
        metaAttemptError: null,
      };
    } else {
      // Sin comprobar o un error que no dice nada del número: se conserva el último estado bueno.
      nuevo = { ...base, metaAttemptAt: ahora, metaAttemptError: r.error ?? 'sin respuesta' };
    }

    // Desde cuándo está caído (lo vimos), y la última vez que funcionaba.
    const caidoAntes = metaDesconectado(base.metaStatus);
    const caidoAhora = metaDesconectado(nuevo.metaStatus);
    if (caidoAhora && !caidoAntes) nuevo.metaFailingSince = ahora;
    if (!caidoAhora) nuevo.metaFailingSince = null;
    if (r.tipo === 'ok' && !caidoAhora) nuevo.metaLastOkAt = ahora;

    const codigoAntes = codigoMeta(base.metaStatus, base.metaGraphError);
    const codigoAhora = codigoMeta(nuevo.metaStatus, nuevo.metaGraphError);
    if ((base.metaStatus ?? null) !== nuevo.metaStatus || codigoAntes !== codigoAhora) {
      nuevo.metaHistorial = [
        {
          tipo: 'estado' as const,
          at: ahora,
          de: base.metaStatus ?? null,
          a: nuevo.metaStatus ?? null,
          codigoDe: codigoAntes,
          codigoA: codigoAhora,
          error: nuevo.metaError,
        },
        ...(base.metaHistorial ?? []),
      ].slice(0, MAX_HISTORIAL);
    }

    this.estados.set(fila.id, nuevo);

    if ((antes?.metaStatus ?? null) !== nuevo.metaStatus) {
      const texto = `Meta: "${fila.name}" pasa de ${antes?.metaStatus ?? '(sin comprobar)'} a ${nuevo.metaStatus ?? '(sin comprobar)'}`;
      if (caidoAhora) this.logger.warn(`${texto} — ${nuevo.metaError ?? motivoMeta(nuevo.metaStatus)}`);
      else this.logger.info(texto);
    } else if (r.tipo === 'sin_comprobar' || r.tipo === 'error_graph') {
      this.logger.warn(`Meta: no se pudo comprobar "${fila.name}": ${r.error}`);
    }
    return nuevo;
  }

  /**
   * PD 2026-10-03: un webhook de CUENTA de Meta (`account_update`, `account_alerts`…). Se apunta en
   * el historial de las instancias de ese WABA (o de ese número), se deja una línea clara en el log
   * y se lanza un chequeo de esas instancias, para que el estado no espere a los 30 min.
   * NO toca el flujo de mensajes. NUNCA lanza.
   */
  public async registrarAvisoCuenta(aviso: {
    wabaId?: string | null;
    time?: number | null;
    field: string;
    value: any;
  }): Promise<{ instancias: string[] }> {
    try {
      const v = aviso.value ?? {};
      const resumen = resumenAvisoCuenta(aviso.field, v);
      let valor: unknown = v;
      try {
        const json = JSON.stringify(v);
        if (json.length > 4000) valor = `${json.slice(0, 4000)}…`;
      } catch {
        valor = String(v);
      }
      const entrada: AvisoSinInstancia = {
        tipo: 'aviso',
        at: this.ahora(),
        metaAt: aviso.time ? new Date(aviso.time * 1000).toISOString() : null,
        field: aviso.field,
        wabaId: aviso.wabaId ?? null,
        resumen,
        value: valor,
      };

      const clientName = this.configService.get<Database>('DATABASE')?.CONNECTION?.CLIENT_NAME;
      const numeros = [v.phone_number_id, v.entity_id].filter(Boolean).map(String);
      // En el ejemplo de Meta de `PARTNER_REMOVED`, `entry.id` y `waba_info.waba_id` son DISTINTOS:
      // se busca por los dos.
      const wabas = [aviso.wabaId, v.waba_info?.waba_id].filter(Boolean).map(String);
      const filas: FilaConWaba[] = await this.prismaRepository.instance.findMany({
        where: {
          integration: Integration.WHATSAPP_BUSINESS,
          ...(clientName ? { clientName } : {}),
          OR: [
            ...(wabas.length ? [{ businessId: { in: wabas } }] : []),
            ...(numeros.length ? [{ number: { in: numeros } }] : []),
          ],
        },
        select: { id: true, name: true, number: true, token: true, businessId: true },
      });

      // Si el aviso dice el número visible, se queda solo con esa instancia del WABA.
      const digitos = (x?: string | null) => (x ?? '').replace(/\D/g, '');
      let elegidas = filas;
      if (v.display_phone_number && filas.length > 1) {
        const mismas = filas.filter(
          (f) => digitos(this.estados.get(f.id)?.displayPhone) === digitos(v.display_phone_number),
        );
        if (mismas.length) elegidas = mismas;
      }

      if (!elegidas.length) {
        this.avisosSinInstancia = [entrada, ...this.avisosSinInstancia].slice(0, MAX_HISTORIAL);
        this.logger.warn(`Meta: aviso de cuenta SIN instancia (WABA ${aviso.wabaId ?? '?'}): ${resumen}`);
        this.persistir();
        return { instancias: [] };
      }

      for (const f of elegidas) {
        const e =
          this.estadoDe(f.id, f.number) ?? this.vacio({ instanceId: f.id, instanceName: f.name, number: f.number });
        this.estados.set(f.id, {
          ...e,
          instanceName: f.name,
          metaHistorial: [entrada, ...(e.metaHistorial ?? [])].slice(0, MAX_HISTORIAL),
        });
      }
      const nombres = elegidas.map((f) => f.name);
      this.logger.warn(`Meta: aviso de cuenta para ${nombres.map((n) => `"${n}"`).join(', ')}: ${resumen}`);
      this.persistir();

      // Un aviso de cuenta suele querer decir que algo cambió: se comprueba ya. Como mucho una vez
      // cada 5 min por instancia: `/webhook/meta` no verifica la firma de Meta, y un aviso falso
      // repetido no debe convertirse en una ráfaga de llamadas a Graph con nuestro token.
      const ahoraMs = Date.parse(this.ahora());
      const toca = nombres.filter((n) => ahoraMs - (this.ultimoChequeoPorAviso.get(n) ?? 0) >= 5 * 60_000);
      toca.forEach((n) => this.ultimoChequeoPorAviso.set(n, ahoraMs));
      if (toca.length) this.comprobar(toca).catch(() => undefined);
      return { instancias: nombres };
    } catch (error) {
      this.logger.warn(`Meta: no se pudo apuntar el aviso de cuenta ${aviso.field}: ${error?.message ?? error}`);
      return { instancias: [] };
    }
  }

  /**
   * Añade el estado de Meta a las filas de `fetchInstances`. Solo cambia la RESPUESTA:
   * - toda Cloud API lleva `metaStatus`, `metaCheckedAt`, `metaError`, `displayPhone`,
   *   `metaMotivo` (en español), `metaConnected` y el resto de datos del chequeo;
   * - si Meta dice que el número no funciona y lo guardado es 'open', `connectionStatus` sale
   *   'close' y lo guardado viaja en `connectionStatusGuardado`.
   * Nada de esto se escribe en la base ni en memoria del servicio de la instancia.
   */
  public anotar<T extends { id?: string; integration?: string | null; number?: string | null; connectionStatus?: any }>(
    filas: T[],
  ): T[] {
    if (!Array.isArray(filas)) return filas;
    return filas.map((fila) => {
      if (fila?.integration !== Integration.WHATSAPP_BUSINESS) return fila;
      const e = this.estadoDe(fila.id, fila.number);
      const desconectado = metaDesconectado(e?.metaStatus);
      const extra: Record<string, unknown> = {
        metaStatus: e?.metaStatus ?? null,
        metaCheckedAt: e?.metaCheckedAt ?? null,
        metaError: e?.metaError ?? null,
        metaAttemptAt: e?.metaAttemptAt ?? null,
        metaAttemptError: e?.metaAttemptError ?? null,
        metaConnected: e?.metaStatus ? !desconectado : null,
        metaMotivo: motivoMeta(e?.metaStatus, e?.metaAttemptError),
        displayPhone: e?.displayPhone ?? null,
        metaVerifiedName: e?.verifiedName ?? null,
        metaQualityRating: e?.qualityRating ?? null,
        metaNameStatus: e?.nameStatus ?? null,
        metaNewNameStatus: e?.newNameStatus ?? null,
        metaProfilePicUrl: e?.profilePicUrl ?? null,
        // Para saber a futuro QUÉ TIPO de desconexión fue (Luis, 3 oct 2026).
        metaCodigo: codigoMeta(e?.metaStatus, e?.metaGraphError),
        metaGraphError: e?.metaGraphError ?? null,
        metaFailingSince: e?.metaFailingSince ?? null,
        metaLastOkAt: e?.metaLastOkAt ?? null,
        metaHistorial: (e?.metaHistorial ?? []).slice(0, 10),
        metaUltimoAviso: (e?.metaHistorial ?? []).find((h) => h.tipo === 'aviso') ?? null,
      };
      if (desconectado && fila.connectionStatus === 'open') {
        extra.connectionStatus = 'close';
        extra.connectionStatusGuardado = fila.connectionStatus;
      }
      return { ...fila, ...extra };
    });
  }
}
