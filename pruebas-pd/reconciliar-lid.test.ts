/**
 * PD 2026-10-10: pruebas de la vuelta atrás de los `@lid` guardados (`reconciliar-lid.ts`), más una
 * lectura del fuente que vigila que el servicio la siga programando. Sin socket y sin base.
 *
 *   npx tsx --test pruebas-pd/reconciliar-lid.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { paresDelHistorial, reconciliarLidsGuardados } from '../src/api/integrations/channel/whatsapp/reconciliar-lid';

const montar = (guardados: string[], mapa: Record<string, string | undefined>, mensajes: Record<string, number> = {}) => {
  const movidos: Array<[string, string]> = [];
  return {
    movidos,
    piezas: {
      lidsGuardados: async () => guardados,
      telefonoDe: async (lid: string) => mapa[lid],
      mover: async (lid: string, telefono: string) => {
        movidos.push([lid, telefono]);
        return mensajes[lid] ?? 1;
      },
    },
  };
};

describe('reconciliarLidsGuardados', () => {
  it('pasa al teléfono lo guardado con un @lid cuyo par ya se conoce (Elena, Dental Shine, 9 oct)', async () => {
    const { piezas, movidos } = montar(
      ['156130785366032@lid'],
      { '156130785366032@lid': '18298854549@s.whatsapp.net' },
      { '156130785366032@lid': 18 },
    );
    const r = await reconciliarLidsGuardados(piezas);
    assert.deepEqual(movidos, [['156130785366032@lid', '18298854549@s.whatsapp.net']]);
    assert.deepEqual(r, { revisados: 1, chats: 1, mensajes: 18, fallidos: 0 });
  });

  it('quien no tiene par (oculta su número de verdad) no se toca', async () => {
    const { piezas, movidos } = montar(['193196537679956@lid'], {});
    const r = await reconciliarLidsGuardados(piezas);
    assert.deepEqual(movidos, []);
    assert.deepEqual(r, { revisados: 1, chats: 0, mensajes: 0, fallidos: 0 });
  });

  it('no mueve nada a algo que no sea un teléfono', async () => {
    const { piezas, movidos } = montar(['1@lid', '2@lid', '3@lid'], {
      '1@lid': '999@lid',
      '2@lid': '18298854549:0@s.whatsapp.net',
      '3@lid': '120363@g.us',
    });
    await reconciliarLidsGuardados(piezas);
    assert.deepEqual(movidos, []);
  });

  it('ignora lo que no es un @lid aunque venga en la lista', async () => {
    const { piezas, movidos } = montar(['18298854549@s.whatsapp.net', 'status@broadcast'], {
      '18298854549@s.whatsapp.net': '18298854549@s.whatsapp.net',
    });
    const r = await reconciliarLidsGuardados(piezas);
    assert.deepEqual(movidos, []);
    assert.equal(r.revisados, 0);
  });

  it('un chat que falla no deja sin corregir a los demás, y se avisa', async () => {
    const avisos: string[] = [];
    const movidos: string[] = [];
    const r = await reconciliarLidsGuardados({
      lidsGuardados: async () => ['1@lid', '2@lid'],
      telefonoDe: async () => '18298854549@s.whatsapp.net',
      mover: async (lid) => {
        if (lid === '1@lid') throw new Error('base caída');
        movidos.push(lid);
        return 3;
      },
      avisar: (t) => avisos.push(t),
    });
    assert.deepEqual(movidos, ['2@lid']);
    assert.deepEqual(r, { revisados: 2, chats: 1, mensajes: 3, fallidos: 1 });
    assert.equal(avisos.length, 1);
  });
});

describe('el servicio de Baileys sigue programando la reconciliación', () => {
  const fuente = readFileSync(
    join(__dirname, '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'),
    'utf8',
  );
  const cuerpo = (firma: string) => {
    const desde = fuente.indexOf(firma);
    assert.notEqual(desde, -1, `no se encuentra ${firma}`);
    return fuente.slice(desde, desde + 2600);
  };

  it('al abrir la conexión', () => {
    assert.match(cuerpo("if (connection === 'open') {"), /this\.programarReconciliacionDeLids\(/);
  });

  it('al resolver un @lid que llega (su par se acaba de conocer)', () => {
    assert.match(cuerpo('private async resolverTelefonoDeLid('), /this\.programarReconciliacionDeLids\(/);
  });

  it('al pedirle a WhatsApp el @lid de un teléfono', () => {
    assert.match(cuerpo('private async conLidDeCadaTelefono('), /this\.programarReconciliacionDeLids\(/);
  });
});

describe('paresDelHistorial', () => {
  it('un chat que llega por su @lid trae su teléfono en phoneNumber', () => {
    assert.deepEqual(paresDelHistorial([{ id: '209641749381308@lid', phoneNumber: '18095551234@s.whatsapp.net' }]), [
      { lid: '209641749381308@lid', pn: '18095551234@s.whatsapp.net' },
    ]);
  });

  it('un chat que llega por su teléfono trae su @lid en lid', () => {
    assert.deepEqual(paresDelHistorial([{ id: '18095551234@s.whatsapp.net', lid: '209641749381308@lid' }]), [
      { lid: '209641749381308@lid', pn: '18095551234@s.whatsapp.net' },
    ]);
  });

  it('sin las dos mitades no hay par, y los grupos no cuentan', () => {
    assert.deepEqual(
      paresDelHistorial([
        { id: '209641749381308@lid' },
        { id: '18095551234@s.whatsapp.net' },
        { id: '120363@g.us', lid: '1@lid' },
        { id: '1@lid', phoneNumber: '2@lid' },
      ]),
      [],
    );
    assert.deepEqual(paresDelHistorial(null), []);
  });

  it('el manejador del historial los guarda antes de procesar los mensajes', () => {
    const fuente = readFileSync(
      join(__dirname, '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'),
      'utf8',
    );
    const desde = fuente.indexOf("'messaging-history.set': async");
    const guarda = fuente.indexOf('storeLIDPNMappings(pares)', desde);
    const procesa = fuente.indexOf('timestampLimitToImport', desde);
    assert.ok(guarda > desde && guarda < procesa);
  });
});
