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

import { consultarSaludMeta, metaDesconectado, motivoMeta, ResultadoSaludMeta } from './salud-meta';

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
}

type FilaInstancia = { id: string; name: string; number: string | null; token: string | null };

const ARCHIVO = 'pd-salud-meta.json';

export class SaludMetaService {
  private readonly logger = new Logger('SaludMeta');
  private readonly estados = new Map<string, EstadoMetaInstancia>();
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
      for (const e of Object.values<EstadoMetaInstancia>(datos ?? {})) {
        if (e?.instanceId) this.estados.set(e.instanceId, e);
      }
    } catch (error) {
      this.logger.warn(`No se pudo leer ${this.rutaArchivo}: ${error?.message ?? error}`);
    }
  }

  /** Escribe el archivo con lo que hay en memoria. */
  public persistir() {
    try {
      const dir = this.opciones.dir ?? INSTANCE_DIR;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.rutaArchivo}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.estados), null, 2));
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
      : {
          instanceId: fila.id,
          instanceName: fila.name,
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
        };

    let nuevo: EstadoMetaInstancia;
    if (r.tipo === 'ok') {
      nuevo = {
        ...base,
        metaStatus: r.metaStatus,
        metaCheckedAt: ahora,
        metaError: null,
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
        metaAttemptAt: ahora,
        metaAttemptError: null,
      };
    } else {
      // Sin comprobar o un error que no dice nada del número: se conserva el último estado bueno.
      nuevo = { ...base, metaAttemptAt: ahora, metaAttemptError: r.error ?? 'sin respuesta' };
    }

    this.estados.set(fila.id, nuevo);

    if ((antes?.metaStatus ?? null) !== nuevo.metaStatus) {
      const texto = `Meta: "${fila.name}" pasa de ${antes?.metaStatus ?? '(sin comprobar)'} a ${nuevo.metaStatus ?? '(sin comprobar)'}`;
      if (metaDesconectado(nuevo.metaStatus))
        this.logger.warn(`${texto} — ${nuevo.metaError ?? motivoMeta(nuevo.metaStatus)}`);
      else this.logger.info(texto);
    } else if (r.tipo === 'sin_comprobar' || r.tipo === 'error_graph') {
      this.logger.warn(`Meta: no se pudo comprobar "${fila.name}": ${r.error}`);
    }
    return nuevo;
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
      };
      if (desconectado && fila.connectionStatus === 'open') {
        extra.connectionStatus = 'close';
        extra.connectionStatusGuardado = fila.connectionStatus;
      }
      return { ...fila, ...extra };
    });
  }
}
