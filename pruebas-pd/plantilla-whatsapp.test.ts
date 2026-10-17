/**
 * PD 2026-10-17: las variables del selector de plantillas de Chatwoot → los `components` de Meta.
 * Nada aquí llama a Meta ni a producción.
 *
 *   npx tsx --test pruebas-pd/plantilla-whatsapp.test.ts
 */
import { componentesDePlantilla, errorDeMeta, pideImagenDeEjemplo } from '@utils/pdPlantillaWhatsapp';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('componentesDePlantilla', () => {
  it('el envío REAL que falló el 17 oct (mensaje 433470): cinco variables agrupadas en body', () => {
    // Antes salía UN parámetro llamado «body» y Meta respondía #132000 (1 frente a 5).
    const real = {
      body: { hora: '5PM', fecha: 'Sábado 17 Octubre', motivo: 'Consulta', nombre: 'Luis', clinica: 'Proyección Digital' },
    };
    const c = componentesDePlantilla(real);
    assert.equal(c.length, 1);
    assert.equal(c[0].type, 'body');
    assert.equal(c[0].parameters.length, 5);
    assert.deepEqual(c[0].parameters[4], { type: 'text', parameter_name: 'clinica', text: 'Proyección Digital' });
  });

  it('la forma plana de antes (8 sep 2026) sigue valiendo', () => {
    assert.deepEqual(componentesDePlantilla({ nombre: 'Carlos' }), [
      { type: 'body', parameters: [{ type: 'text', parameter_name: 'nombre', text: 'Carlos' }] },
    ]);
  });

  it('los posicionales salen en su orden aunque lleguen desordenados', () => {
    const c = componentesDePlantilla({ body: { '2': 'b', '1': 'a' } });
    assert.deepEqual(
      c[0].parameters.map((p: any) => p.text),
      ['a', 'b'],
    );
  });

  it('imagen + texto fijo: solo el encabezado', () => {
    assert.deepEqual(componentesDePlantilla({ header: { media_url: 'https://x.org/a.jpg', media_type: 'image' } }), [
      { type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.org/a.jpg' } }] },
    ]);
  });

  it('con el archivo ya subido al número, el encabezado va por id y no por enlace', () => {
    // El enlace del ejemplo no vale para enviar (131053, 403): Evolution lo sube y pone `media_id`.
    assert.deepEqual(
      componentesDePlantilla({
        header: { media_url: 'https://scontent.whatsapp.net/x.jpg', media_type: 'image', media_id: '123' },
      }),
      [{ type: 'header', parameters: [{ type: 'image', image: { id: '123' } }] }],
    );
  });

  it('un botón de URL con variable va en su índice', () => {
    assert.deepEqual(componentesDePlantilla({ buttons: [null, { type: 'url', parameter: 'abc' }] }), [
      { type: 'button', sub_type: 'url', index: 1, parameters: [{ type: 'text', text: 'abc' }] },
    ]);
  });

  it('una plantilla sin nada que rellenar va sin componentes', () => {
    assert.deepEqual(componentesDePlantilla({}), []);
  });
});

describe('pideImagenDeEjemplo', () => {
  it('se pide a Meta si no hay imagen o si es la del ejemplo (caduca)', () => {
    assert.equal(pideImagenDeEjemplo({ header: { media_url: '', media_type: 'image' } }), true);
    assert.equal(
      pideImagenDeEjemplo({
        header: { media_url: 'https://scontent.whatsapp.net/v/t61/x.jpg?oe=6AFAE848', media_type: 'image' },
      }),
      true,
    );
  });

  it('una imagen propia se respeta, y sin encabezado de medio no se pide nada', () => {
    assert.equal(
      pideImagenDeEjemplo({ header: { media_url: 'https://proyecciondigital.org/a.jpg', media_type: 'image' } }),
      false,
    );
    assert.equal(pideImagenDeEjemplo({ body: { nombre: 'x' } }), false);
  });
});

describe('errorDeMeta', () => {
  it('junta el mensaje y el detalle', () => {
    assert.equal(
      errorDeMeta({ message: '(#132000) Number of parameters does not match', error_data: { details: 'body: 1 vs 5' } }),
      '(#132000) Number of parameters does not match — body: 1 vs 5',
    );
  });
});
