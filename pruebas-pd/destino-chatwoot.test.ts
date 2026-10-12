/**
 * PD 2026-10-12: a quién se le escribe cuando Chatwoot pasa una respuesta.
 * Con QR y Cloud API en el mismo número, la ficha de Chatwoot lleva el `@lid` como identificador
 * y la Cloud API lo mandaba ahí: Meta respondía 131026 y el mensaje se perdía (Dento Estetic).
 *
 *   npx tsx --test pruebas-pd/destino-chatwoot.test.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { destinoDesdeChatwoot } from '../src/utils/createJid';

describe('destinoDesdeChatwoot', () => {
  const conLid = { identifier: '259021072289830@lid', phone_number: '+584245441315' };

  it('🔴 Cloud API: con @lid y teléfono, manda al teléfono', () => {
    assert.equal(destinoDesdeChatwoot(conLid, true), '584245441315');
  });

  it('QR (Baileys): el @lid se respeta, como siempre', () => {
    assert.equal(destinoDesdeChatwoot(conLid, false), '259021072289830@lid');
  });

  it('Cloud API: un identificador normal no cambia', () => {
    assert.equal(
      destinoDesdeChatwoot({ identifier: '584245441315@s.whatsapp.net', phone_number: '+584245441315' }, true),
      '584245441315@s.whatsapp.net',
    );
  });

  it('Cloud API: un BSUID (lead de anuncio sin teléfono) se queda como está', () => {
    assert.equal(destinoDesdeChatwoot({ identifier: 'DO.937659916066542', phone_number: null }, true), 'DO.937659916066542');
  });

  it('Cloud API: un @lid SIN teléfono no se puede arreglar aquí: se devuelve tal cual', () => {
    assert.equal(destinoDesdeChatwoot({ identifier: '259021072289830@lid' }, true), '259021072289830@lid');
  });

  it('sin identificador, el teléfono sin el +', () => {
    assert.equal(destinoDesdeChatwoot({ phone_number: '+18095550101' }, false), '18095550101');
    assert.equal(destinoDesdeChatwoot(undefined, true), undefined);
  });
});
