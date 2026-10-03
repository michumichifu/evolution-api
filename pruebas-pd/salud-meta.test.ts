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

import { consultarSaludMeta, metaDesconectado, motivoMeta } from '../src/api/integrations/channel/meta/salud-meta';
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
    assert.equal(g.pedidas.length, 1);
    assert.equal(metaDesconectado(r.metaStatus), true);
    assert.equal(motivoMeta(r.metaStatus), 'Meta: sin acceso al número (¿coexistencia sin actividad o permiso retirado?)');
  });

  it('code 190: TOKEN_INVALID', async () => {
    const g = graphFalso([{ si: /\?fields=status/, status: 401, body: ERROR_190 }]);
    const r = await consultarSaludMeta({ ...BASE, fetchImpl: g.impl });
    assert.equal(r.tipo, 'token_invalido');
    assert.equal(r.metaStatus, 'TOKEN_INVALID');
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
  const servicio = new SaludMetaService(prismaFalso, configFalsa, {
    dir,
    consultar: async () => siguiente,
    ahora: () => new Date('2026-10-03T12:00:00Z'),
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
    siguiente = { tipo: 'sin_acceso', metaStatus: 'NO_ACCESS', error: 'Unsupported get request (code 100, subcode 33)' };
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
  });

  it('un timeout después de NO_ACCESS sigue diciendo NO_ACCESS (último dato concluyente)', async () => {
    siguiente = { tipo: 'sin_comprobar', metaStatus: null, error: 'Sin respuesta de Meta' };
    const [e] = await servicio.comprobar();
    assert.equal(e.metaStatus, 'NO_ACCESS');
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
    assert.equal(guardado['id-cloud'].metaStatus, 'NO_ACCESS');
    const otro = new SaludMetaService(prismaFalso, configFalsa, { dir });
    assert.equal((otro.anotar([filaFetch()])[0] as any).connectionStatus, 'close');
    const [otroNumero] = otro.anotar([{ ...filaFetch(), number: '999' }]) as any[];
    assert.equal(otroNumero.connectionStatus, 'open');
    assert.equal(otroNumero.metaStatus, null);
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
