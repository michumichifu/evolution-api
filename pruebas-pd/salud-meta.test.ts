/**
 * PD 2026-10-03: pruebas del chequeo del estado de Meta de las instancias Cloud API.
 * Graph va SIMULADO: nada aquí llama a Meta ni a producción.
 *
 *   npx tsx --test pruebas-pd/salud-meta.test.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  codigoMeta,
  consultarSaludMeta,
  metaDesconectado,
  motivoMeta,
  resumenAvisoCuenta,
} from '../src/api/integrations/channel/meta/salud-meta';
import { SaludMetaService } from '../src/api/integrations/channel/meta/salud-meta.service';

const BASE = { base: 'https://graph.example.invalid', version: 'v20.0', number: '1219661531237557', token: 'TOKEN' };

/** Un `fetch` falso que contesta según la URL y apunta lo que se le pidió. */
function graphFalso(respuestas: Array<{ si: RegExp; status: number; body: any }>) {
  const pedidas: string[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    pedidas.push(String(url));
    assert.equal((init?.headers as any)?.Authorization, 'Bearer TOKEN');
    const r = respuestas.find((x) => x.si.test(String(url)));
    if (!r) throw new Error(`URL no prevista: ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, pedidas };
}

/** Un `fetch` que no contesta nunca y solo cede al AbortSignal (el timeout). */
const fetchQueNoContesta = ((_url: string, init?: RequestInit) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  })) as unknown as typeof fetch;

const ERROR_100_33 = {
  error: {
    message:
      "Unsupported get request. Object with ID '1219661531237557' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
    type: 'GraphMethodException',
    code: 100,
    error_subcode: 33,
    fbtrace_id: 'AbC',
  },
};
const ERROR_190 = { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } };

describe('consultarSaludMeta (Graph simulado)', () => {
  it('CONNECTED: estado, número visible y foto', async () => {
    const g = graphFalso([
      { si: /whatsapp_business_profile/, status: 200, body: { data: [{ profile_picture_url: 'https://pps.example/foto.jpg' }] } },
      {
        si: /\?fields=status/,
        status: 200,
        body: {
          status: 'CONNECTED',
          display_phone_number: '+1 809-555-0100',
          verified_name: 'Zenithe',
          quality_rating: 'GREEN',
          name_status: 'APPROVED',
          new_name_status: 'NONE',
          id: '1219661531237557',
        },
      },
    ]);
    const r = await consultarSaludMeta({ ...BASE, fetchImpl: g.impl });
    assert.equal(r.tipo, 'ok');
    assert.equal(r.metaStatus, 'CONNECTED');
    assert.equal(r.displayPhone, '+1 809-555-0100');
    assert.equal(r.verifiedName, 'Zenithe');
    assert.equal(r.qualityRating, 'GREEN');
    assert.equal(r.profilePicUrl, 'https://pps.example/foto.jpg');
    assert.match(
      g.pedidas[0],
      /^https:\/\/graph\.example\.invalid\/v20\.0\/1219661531237557\?fields=status,display_phone_number,verified_name,quality_rating,name_status,new_name_status$/,
    );
    assert.equal(metaDesconectado(r.metaStatus), false);
    assert.equal(motivoMeta(r.metaStatus), null);
  });

  it('code 100 / subcode 33: NO_ACCESS, con el error de Graph, y no se pide la foto', async () => {
    const g = graphFalso([{ si: /\?fields=status/, status: 400, body: ERROR_100_33 }]);
    const r = await consultarSaludMeta({ ...BASE, fetchImpl: g.impl });
    assert.equal(r.tipo, 'sin_acceso');
    assert.equal(r.metaStatus, 'NO_ACCESS');
    assert.match(r.error, /GraphMethodException, code 100, subcode 33/);
    // El error ENTERO y estructurado, para saber a futuro qué tipo de desconexión fue.
    assert.deepEqual(r.graphError, {
      code: 100,
      error_subcode: 33,
      type: 'GraphMethodException',
      message: ERROR_100_33.error.message,
      fbtrace_id: 'AbC',
    });
    assert.equal(codigoMeta(r.metaStatus, r.graphError), '100/33');
    assert.equal(g.pedidas.length, 1);
    assert.equal(metaDesconectado(r.metaStatus), true);
    assert.equal(motivoMeta(r.metaStatus), 'Meta: sin acceso al número (¿coexistencia sin actividad o permiso retirado?)');
  });

  it('code 190: TOKEN_INVALID', async () => {
    const g = graphFalso([{ si: /\?fields=status/, status: 401, body: ERROR_190 }]);
    const r = await consultarSaludMeta({ ...BASE, fetchImpl: g.impl });
    assert.equal(r.tipo, 'token_invalido');
    assert.equal(r.metaStatus, 'TOKEN_INVALID');
    assert.equal(codigoMeta(r.metaStatus, r.graphError), '190');
    assert.equal(metaDesconectado(r.metaStatus), true);
    assert.equal(motivoMeta(r.metaStatus), 'Meta: token inválido o caducado');
  });

  it('timeout: «sin comprobar», NUNCA desconectado', async () => {
    // El temporizador de AbortSignal.timeout no mantiene vivo el proceso (en el servidor sí lo
    // está): sin este intervalo, node:test da la prueba por abandonada.
    const vivo = setInterval(() => undefined, 1000);
    const r = await consultarSaludMeta({ ...BASE, fetchImpl: fetchQueNoContesta, timeoutMs: 50 }).finally(() =>
      clearInterval(vivo),
    );
    assert.equal(r.tipo, 'sin_comprobar');
    assert.equal(r.metaStatus, null);
    assert.match(r.error, /Sin respuesta de Meta/);
    assert.equal(metaDesconectado(r.metaStatus), false);
  });

  it('500 y límite de llamadas (code 4): «sin comprobar»', async () => {
    for (const [status, body] of [
      [500, { error: { message: 'An unexpected error has occurred', code: 2, type: 'OAuthException' } }],
      [400, { error: { message: 'Application request limit reached', code: 4, type: 'OAuthException' } }],
      [502, null],
    ] as const) {
      const g = graphFalso([{ si: /\?fields=status/, status, body }]);
      const r = await consultarSaludMeta({ ...BASE, fetchImpl: g.impl });
      assert.equal(r.tipo, 'sin_comprobar', `status ${status}`);
      assert.equal(r.metaStatus, null);
    }
  });

  it('un status de Meta que no es CONNECTED se lee como desconectado (salvo los que siguen funcionando)', async () => {
    const g = graphFalso([
      { si: /whatsapp_business_profile/, status: 200, body: { data: [] } },
      { si: /\?fields=status/, status: 200, body: { status: 'DISCONNECTED', display_phone_number: '+1 809-555-0100' } },
    ]);
    const r = await consultarSaludMeta({ ...BASE, fetchImpl: g.impl });
    assert.equal(r.metaStatus, 'DISCONNECTED');
    assert.equal(metaDesconectado('DISCONNECTED'), true);
    assert.equal(motivoMeta('DISCONNECTED'), 'Meta: número fuera de internet');
    assert.equal(metaDesconectado('FLAGGED'), false);
    assert.equal(metaDesconectado('RATE_LIMITED'), false);
    assert.equal(metaDesconectado(null), false);
  });
});

describe('SaludMetaService (Graph y base simulados)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'salud-meta-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const filas = [{ id: 'id-cloud', name: 'Zenithe 2 - Cloud Api', number: '1219661531237557', token: 'TOKEN' }];
  // 🔴 Una base falsa que SOLO sabe leer: si el servicio intentara escribir algo (update,
  // upsert…) la prueba revienta. Es la trampa 1: el estado de Meta no va a `connectionStatus`.
  const consultas: any[] = [];
  const prismaFalso = {
    instance: {
      findMany: async (args: any) => {
        consultas.push(args);
        return filas;
      },
    },
  } as any;
  const configFalsa = {
    get: (k: string) =>
      k === 'WA_BUSINESS'
        ? { URL: 'https://graph.example.invalid', VERSION: 'v20.0' }
        : k === 'DATABASE'
          ? { CONNECTION: { CLIENT_NAME: 'evolution_exchange' } }
          : undefined,
  } as any;

  let siguiente: any;
  let reloj = new Date('2026-10-03T12:00:00Z');
  const servicio = new SaludMetaService(prismaFalso, configFalsa, {
    dir,
    consultar: async () => siguiente,
    ahora: () => reloj,
  });

  const filaFetch = (connectionStatus = 'open') => ({
    id: 'id-cloud',
    name: 'Zenithe 2 - Cloud Api',
    integration: 'WHATSAPP-BUSINESS',
    number: '1219661531237557',
    connectionStatus,
  });

  it('solo consulta las Cloud API de este cliente, y no escribe en la base', async () => {
    siguiente = { tipo: 'ok', metaStatus: 'CONNECTED', displayPhone: '+1 809-555-0100', verifiedName: 'Zenithe' };
    const [e] = await servicio.comprobar();
    assert.equal(e.metaStatus, 'CONNECTED');
    assert.equal(consultas[0].where.integration, 'WHATSAPP-BUSINESS');
    assert.equal(consultas[0].where.clientName, 'evolution_exchange');
    const [fila] = servicio.anotar([filaFetch()]);
    assert.equal((fila as any).connectionStatus, 'open');
    assert.equal((fila as any).metaConnected, true);
    assert.equal((fila as any).displayPhone, '+1 809-555-0100');
    assert.equal((fila as any).metaMotivo, null);
  });

  it('un timeout después de CONNECTED conserva CONNECTED y apunta el intento fallido', async () => {
    siguiente = { tipo: 'sin_comprobar', metaStatus: null, error: 'Sin respuesta de Meta: TimeoutError' };
    const [e] = await servicio.comprobar();
    assert.equal(e.metaStatus, 'CONNECTED');
    assert.equal(e.metaAttemptError, 'Sin respuesta de Meta: TimeoutError');
    assert.equal((servicio.anotar([filaFetch()])[0] as any).connectionStatus, 'open');
  });

  it('NO_ACCESS: la RESPUESTA dice close, lo guardado viaja aparte y el número visible se conserva', async () => {
    reloj = new Date('2026-10-03T12:30:00Z');
    siguiente = {
      tipo: 'sin_acceso',
      metaStatus: 'NO_ACCESS',
      error: 'Unsupported get request (code 100, subcode 33)',
      graphError: { code: 100, error_subcode: 33, type: 'GraphMethodException', message: 'Unsupported get request', fbtrace_id: 'X1' },
    };
    await servicio.comprobar();
    const entrada = filaFetch();
    const [fila] = servicio.anotar([entrada]) as any[];
    assert.equal(fila.connectionStatus, 'close');
    assert.equal(fila.connectionStatusGuardado, 'open');
    assert.equal(fila.metaStatus, 'NO_ACCESS');
    assert.equal(fila.metaConnected, false);
    assert.match(fila.metaError, /subcode 33/);
    assert.equal(fila.metaMotivo, 'Meta: sin acceso al número (¿coexistencia sin actividad o permiso retirado?)');
    assert.equal(fila.displayPhone, '+1 809-555-0100');
    assert.equal(entrada.connectionStatus, 'open', 'la fila original no se toca');
    // Qué tipo de desconexión y desde cuándo (Luis, 3 oct 2026)
    assert.equal(fila.metaCodigo, '100/33');
    assert.equal(fila.metaGraphError.fbtrace_id, 'X1');
    assert.equal(fila.metaFailingSince, '2026-10-03T12:30:00.000Z');
    assert.equal(fila.metaLastOkAt, '2026-10-03T12:00:00.000Z');
    assert.deepEqual(fila.metaHistorial[0], {
      tipo: 'estado',
      at: '2026-10-03T12:30:00.000Z',
      de: 'CONNECTED',
      a: 'NO_ACCESS',
      codigoDe: 'CONNECTED',
      codigoA: '100/33',
      error: 'Unsupported get request (code 100, subcode 33)',
    });
  });

  it('un timeout después de NO_ACCESS sigue diciendo NO_ACCESS y conserva el «desde»', async () => {
    reloj = new Date('2026-10-03T13:00:00Z');
    siguiente = { tipo: 'sin_comprobar', metaStatus: null, error: 'Sin respuesta de Meta' };
    const [e] = await servicio.comprobar();
    assert.equal(e.metaStatus, 'NO_ACCESS');
    assert.equal(e.metaFailingSince, '2026-10-03T12:30:00.000Z');
    assert.equal(e.metaHistorial.filter((h) => h.tipo === 'estado').length, 2, 'un timeout no es un cambio');
  });

  it('una instancia QR no se toca, y una Cloud API ya cerrada no se reescribe', () => {
    const qr = { id: 'x', integration: 'WHATSAPP-BAILEYS', connectionStatus: 'open' };
    assert.deepEqual(servicio.anotar([qr])[0], qr);
    const [cerrada] = servicio.anotar([filaFetch('close')]) as any[];
    assert.equal(cerrada.connectionStatus, 'close');
    assert.equal(cerrada.connectionStatusGuardado, undefined);
  });

  it('el estado sobrevive a un reinicio (archivo) y se descarta si cambia el phone_number_id', () => {
    const guardado = JSON.parse(readFileSync(join(dir, 'pd-salud-meta.json'), 'utf8'));
    assert.equal(guardado.instancias['id-cloud'].metaStatus, 'NO_ACCESS');
    assert.equal(guardado.instancias['id-cloud'].metaFailingSince, '2026-10-03T12:30:00.000Z');
    const otro = new SaludMetaService(prismaFalso, configFalsa, { dir });
    assert.equal((otro.anotar([filaFetch()])[0] as any).connectionStatus, 'close');
    const [otroNumero] = otro.anotar([{ ...filaFetch(), number: '999' }]) as any[];
    assert.equal(otroNumero.connectionStatus, 'open');
    assert.equal(otroNumero.metaStatus, null);
  });

  it('al volver, se borra el «desde» y queda apuntado el cambio', async () => {
    reloj = new Date('2026-10-03T14:00:00Z');
    siguiente = { tipo: 'ok', metaStatus: 'CONNECTED', displayPhone: '+1 809-555-0100' };
    const [e] = await servicio.comprobar();
    assert.equal(e.metaFailingSince, null);
    assert.equal(e.metaLastOkAt, '2026-10-03T14:00:00.000Z');
    assert.equal(e.metaGraphError, null);
    assert.equal(e.metaHistorial[0].tipo, 'estado');
    assert.equal((e.metaHistorial[0] as any).codigoDe, '100/33');
    assert.equal((e.metaHistorial[0] as any).a, 'CONNECTED');
  });

  it('sin ningún chequeo todavía: open, metaStatus null, nada de motivo', () => {
    const nuevo = new SaludMetaService(prismaFalso, configFalsa, { dir: join(dir, 'vacio') });
    const [f] = nuevo.anotar([filaFetch()]) as any[];
    assert.equal(f.connectionStatus, 'open');
    assert.equal(f.metaStatus, null);
    assert.equal(f.metaConnected, null);
    assert.equal(f.metaMotivo, null);
  });
});

describe('Avisos de cuenta de Meta (webhooks sin número)', () => {
  // El ejemplo «Partner removed (WhatsApp Business app disconnection)» de la doc de Meta
  // (…/webhooks/reference/account_update.md), con el WABA de Zenithe 2.
  const PARTNER_REMOVED = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1241246318075956',
        time: 1759288724,
        changes: [
          {
            value: {
              event: 'PARTNER_REMOVED',
              waba_info: { waba_id: '1241246318075956', owner_business_id: '2329417887457253' },
              disconnection_info: { reason: 'PRIMARY_INACTIVITY', initiated_by: 'SYSTEM' },
            },
            field: 'account_update',
          },
        ],
      },
    ],
  };

  it('el resumen dice qué pasó y si fue solo o el cliente', () => {
    assert.equal(
      resumenAvisoCuenta('account_update', PARTNER_REMOVED.entry[0].changes[0].value),
      'account_update: PARTNER_REMOVED · desconexión sola (Meta), teléfono principal sin actividad ~14 días',
    );
    assert.equal(
      resumenAvisoCuenta('account_update', { event: 'PARTNER_REMOVED', disconnection_info: { reason: 'CHANGE_NUMBER', initiated_by: 'USER' } }),
      'account_update: PARTNER_REMOVED · desconexión por el cliente, el cliente cambió de número',
    );
    assert.equal(resumenAvisoCuenta('account_update', { event: 'ACCOUNT_OFFBOARDED' }), 'account_update: ACCOUNT_OFFBOARDED');
  });

  const dir = mkdtempSync(join(tmpdir(), 'salud-meta-avisos-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const filas = [
    { id: 'z2', name: 'Zenithe 2 - Cloud Api', number: '1219661531237557', token: 'T', businessId: '1241246318075956' },
    { id: 'pd', name: 'PD Cloud', number: '700000000000001', token: 'T', businessId: '999' },
  ];
  const prismaFalso = {
    instance: {
      // Solo lee. Filtra como lo haría Prisma con el `where` que manda el servicio.
      findMany: async ({ where }: any) =>
        filas.filter((f) =>
          where.OR
            ? where.OR.some((c: any) => (c.businessId?.in ?? []).includes(f.businessId) || (c.number?.in ?? []).includes(f.number))
            : !where.name || where.name.in.includes(f.name),
        ),
      findFirst: async ({ where }: any) => filas.find((f) => f.number === where.number) ?? null,
    },
  } as any;
  const configFalsa = {
    get: (k: string) => (k === 'WA_BUSINESS' ? { URL: 'x', VERSION: 'v20.0' } : { CONNECTION: {} }),
  } as any;
  const consultadas: string[] = [];
  const servicio = new SaludMetaService(prismaFalso, configFalsa, {
    dir,
    consultar: async (o: any) => {
      consultadas.push(o.number);
      return { tipo: 'sin_acceso', metaStatus: 'NO_ACCESS', error: 'x', graphError: { code: 100, error_subcode: 33 } } as any;
    },
    ahora: () => new Date('2026-10-03T15:00:00Z'),
  });

  it('se apunta en el historial de la instancia de ese WABA, y se comprueba ya', async () => {
    const r = await servicio.registrarAvisoCuenta({
      wabaId: PARTNER_REMOVED.entry[0].id,
      time: PARTNER_REMOVED.entry[0].time,
      field: 'account_update',
      value: PARTNER_REMOVED.entry[0].changes[0].value,
    });
    assert.deepEqual(r.instancias, ['Zenithe 2 - Cloud Api']);
    await new Promise((ok) => setTimeout(ok, 20)); // el chequeo que dispara va aparte
    assert.deepEqual(consultadas, ['1219661531237557']);
    const [f] = servicio.anotar([
      { id: 'z2', integration: 'WHATSAPP-BUSINESS', number: '1219661531237557', connectionStatus: 'open' },
    ]) as any[];
    assert.equal(f.metaUltimoAviso.field, 'account_update');
    assert.equal(f.metaUltimoAviso.metaAt, new Date(1759288724 * 1000).toISOString());
    assert.match(f.metaUltimoAviso.resumen, /desconexión sola \(Meta\), teléfono principal sin actividad/);
    assert.equal(f.metaUltimoAviso.value.disconnection_info.reason, 'PRIMARY_INACTIVITY');
    const [pd] = servicio.anotar([{ id: 'pd', integration: 'WHATSAPP-BUSINESS', number: '700000000000001', connectionStatus: 'open' }]) as any[];
    assert.equal(pd.metaUltimoAviso, null, 'el aviso de otro WABA no se le apunta');
  });

  it('un segundo aviso a los pocos minutos no vuelve a llamar a Graph (no hay firma que verificar)', async () => {
    await servicio.registrarAvisoCuenta({ wabaId: '1241246318075956', field: 'account_alerts', value: { alert_info: { alert_type: 'X' } } });
    await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(consultadas.length, 1);
  });

  it('un aviso de un WABA sin instancia se guarda aparte, no se pierde', async () => {
    const r = await servicio.registrarAvisoCuenta({ wabaId: '555', field: 'account_update', value: { event: 'ACCOUNT_DELETED' } });
    assert.deepEqual(r.instancias, []);
    const guardado = JSON.parse(readFileSync(join(dir, 'pd-salud-meta.json'), 'utf8'));
    assert.equal(guardado.avisosSinInstancia[0].resumen, 'account_update: ACCOUNT_DELETED');
  });

  it('MetaController: el aviso de cuenta ya no revienta, y los mensajes siguen su camino de siempre', async () => {
    // meta.controller → channel.controller → … → server.module → meta.controller es un ciclo: se entra
    // por server.module, como entra la aplicación, o `ChannelController` aún no existe.
    await import('../src/api/server.module');
    const { MetaController } = await import('../src/api/integrations/channel/meta/meta.controller');
    const recibidos: any[] = [];
    const waMonitor = { waInstances: { 'Zenithe 2 - Cloud Api': { connectToWhatsapp: async (d: any) => recibidos.push(d) } } } as any;
    const apuntados: any[] = [];
    const saludFalsa = { registrarAvisoCuenta: async (a: any) => (apuntados.push(a), { instancias: [] }) } as any;
    const ctrl = new MetaController(prismaFalso, waMonitor, saludFalsa);

    const rechazos: unknown[] = [];
    const oir = (e: unknown) => rechazos.push(e);
    process.on('unhandledRejection', oir);
    try {
      assert.deepEqual(await ctrl.receiveWebhook(PARTNER_REMOVED), { status: 'success' });
      const MENSAJE = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: '1241246318075956',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '18095550100', phone_number_id: '1219661531237557' },
                  statuses: [{ id: 'wamid.X', status: 'delivered', timestamp: '1759288724', recipient_id: '18095550101' }],
                },
              },
            ],
          },
        ],
      };
      await ctrl.receiveWebhook(MENSAJE);
      await new Promise((ok) => setTimeout(ok, 30));
      assert.equal(apuntados.length, 1);
      assert.equal(apuntados[0].field, 'account_update');
      assert.equal(apuntados[0].wabaId, '1241246318075956');
      assert.equal(recibidos.length, 1, 'el mensaje llega a la instancia igual que antes');
      assert.equal(recibidos[0], MENSAJE);
      assert.deepEqual(rechazos, [], 'sin unhandledRejection');
    } finally {
      process.off('unhandledRejection', oir);
    }
  });
});
