/**
 * PD 2026-10-08: pruebas de la decisión de vinculación (QR o código de emparejamiento).
 * Sin socket, sin base y sin WhatsApp: solo la lógica de `vinculacion.ts`, más una lectura del
 * fuente que vigila que `createClient` reponga `isDeleting`.
 *
 *   npx tsx --test pruebas-pd/vinculacion.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  decidirVinculacion,
  esTokenDeMeta,
  generacionLista,
  reiniciarCortaLaGeneracion,
  soloDigitos,
} from '../src/api/integrations/channel/whatsapp/vinculacion';

describe('decidirVinculacion', () => {
  it('pedir el código con un QR abierto CAMBIA de generación (el caso del 8 oct, 00:16:47)', () => {
    assert.equal(
      decidirVinculacion({ estado: 'connecting', enVinculacion: true, numeroActual: null, numeroPedido: '18098448584' }),
      'cambiar',
    );
  });

  it('pedir el QR con un código en curso también cambia', () => {
    assert.equal(
      decidirVinculacion({ estado: 'connecting', enVinculacion: true, numeroActual: '18098448584', numeroPedido: null }),
      'cambiar',
    );
  });

  it('pedir el código de OTRO número cambia', () => {
    assert.equal(
      decidirVinculacion({
        estado: 'connecting',
        enVinculacion: true,
        numeroActual: '18098448584',
        numeroPedido: '18293884783',
      }),
      'cambiar',
    );
  });

  it('el sondeo del Manager (mismo tipo) NO toca el socket', () => {
    assert.equal(
      decidirVinculacion({ estado: 'connecting', enVinculacion: true, numeroActual: undefined, numeroPedido: null }),
      'devolver',
    );
    assert.equal(
      decidirVinculacion({
        estado: 'connecting',
        enVinculacion: true,
        numeroActual: '18098448584',
        numeroPedido: '+1 (809) 844-8584',
      }),
      'devolver',
    );
  });

  it('una instancia YA vinculada que reconecta no se toca, pidan lo que pidan', () => {
    assert.equal(
      decidirVinculacion({ estado: 'connecting', enVinculacion: false, numeroActual: null, numeroPedido: '18098448584' }),
      'devolver',
    );
  });

  it('cerrada abre, conectada devuelve el estado, y sin estado no existe', () => {
    assert.equal(decidirVinculacion({ estado: 'close', enVinculacion: false }), 'abrir');
    assert.equal(decidirVinculacion({ estado: 'open', enVinculacion: false, numeroPedido: '1809' }), 'conectada');
    assert.equal(decidirVinculacion({ estado: undefined, enVinculacion: false }), 'no-existe');
  });
});

describe('reiniciarCortaLaGeneracion', () => {
  it('solo corta en mitad de una generación', () => {
    assert.equal(reiniciarCortaLaGeneracion('connecting', true), true);
    assert.equal(reiniciarCortaLaGeneracion('connecting', false), false); // vinculada reconectando
    assert.equal(reiniciarCortaLaGeneracion('open', false), false);
    assert.equal(reiniciarCortaLaGeneracion('close', false), false);
  });
});

describe('generacionLista', () => {
  it('con número hace falta el código; el QR solo no basta', () => {
    assert.equal(generacionLista({ code: '2@abc', pairingCode: null }, true), false);
    assert.equal(generacionLista({ code: '2@abc', pairingCode: 'E9RSFL77' }, true), true);
  });

  it('sin número basta el QR', () => {
    assert.equal(generacionLista({ code: '2@abc', pairingCode: null }, false), true);
  });

  it('una respuesta vacía (recién abierta) no está lista', () => {
    assert.equal(generacionLista({}, false), false);
    assert.equal(generacionLista(null, true), false);
    assert.equal(generacionLista({ pairingCode: '5QRYZFDR' }, true), false); // código sin QR: resto viejo
  });
});

describe('esTokenDeMeta', () => {
  it('un token de Meta no viaja en el sobre; la llave de una instancia por QR sí', () => {
    assert.equal(esTokenDeMeta('EAAGm0PX4ZCpsBO1234'), true);
    assert.equal(esTokenDeMeta('7B3F9C2A-1D4E-4F60-9A8B-0C1D2E3F4A5B'), false);
    assert.equal(esTokenDeMeta(undefined), false);
    assert.equal(esTokenDeMeta(''), false);
  });
});

describe('soloDigitos', () => {
  it('quita todo lo que no sea un dígito', () => {
    assert.equal(soloDigitos('+1 (809) 844-8584'), '18098448584');
    assert.equal(soloDigitos(null), '');
  });
});

describe('el fuente', () => {
  const baileys = readFileSync(
    join(__dirname, '../src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts'),
    'utf8',
  );
  const canal = readFileSync(join(__dirname, '../src/api/services/channel.service.ts'), 'utf8');

  it('createClient repone isDeleting antes de abrir el socket', () => {
    const desde = baileys.indexOf('private async createClient(');
    const socket = baileys.indexOf('this.client = makeWASocket(socketConfig);', desde);
    assert.ok(desde > 0 && socket > desde, 'no encuentro createClient o su makeWASocket');
    assert.match(baileys.slice(desde, socket), /this\.isDeleting = false;/);
  });

  it('el sobre del webhook no lleva el token de Meta', () => {
    assert.match(canal, /apiKey: expose && instanceApikey && !esTokenDeMeta\(instanceApikey\)/);
  });
});
