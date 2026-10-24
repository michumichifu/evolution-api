/**
 * PD 2026-10-17: las variables del selector de plantillas de Chatwoot → los `components` de Meta.
 * Nada aquí llama a Meta ni a producción.
 *
 *   npx tsx --test pruebas-pd/plantilla-whatsapp.test.ts
 */
import {
  componentesDePlantilla,
  errorDeMeta,
  estructuraDePlantilla,
  pideImagenDeEjemplo,
  respaldoDePlantilla,
  textoDePlantilla,
} from '@utils/pdPlantillaWhatsapp';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('componentesDePlantilla', () => {
  it('el envío REAL que falló el 17 oct (mensaje 433470): cinco variables agrupadas en body', () => {
    // Antes salía UN parámetro llamado «body» y Meta respondía #132000 (1 frente a 5).
    const real = {
      body: {
        hora: '5PM',
        fecha: 'Sábado 17 Octubre',
        motivo: 'Consulta',
        nombre: 'Luis',
        clinica: 'Proyección Digital',
      },
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
      errorDeMeta({
        message: '(#132000) Number of parameters does not match',
        error_data: { details: 'body: 1 vs 5' },
      }),
      '(#132000) Number of parameters does not match — body: 1 vs 5',
    );
  });
});

describe('textoDePlantilla (19 oct 2026)', () => {
  // La definición real de `recordatorio_2_horas_cita` de Dento Estetic, como la da Meta.
  const recordatorio = {
    name: 'recordatorio_2_horas_cita',
    language: 'es',
    parameter_format: 'NAMED',
    components: [
      {
        type: 'BODY',
        text: 'Hola {{nombre}}, te recuerdo que tu cita en {{clinica}} *es en 2 horas* ⏰\n\n📅 *Hoy* a las {{hora}}\n🦷 *Motivo:* {{motivo}}',
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'SÍ, voy en camino' },
          { type: 'QUICK_REPLY', text: 'NO podré llegar' },
        ],
      },
    ],
  };
  const enviados = [
    {
      type: 'body',
      parameters: [
        { type: 'text', parameter_name: 'nombre', text: 'Alexandra' },
        { type: 'text', parameter_name: 'clinica', text: 'Dento Estetic Salud Bucal' },
        { type: 'text', parameter_name: 'hora', text: '16:00' },
        { type: 'text', parameter_name: 'motivo', text: 'Evaluación prótesis removible' },
      ],
    },
  ];

  it('el recordatorio que se vio como «▶️recordatorio2horas_cita◀️» sale con su texto y sus botones', () => {
    assert.equal(
      textoDePlantilla(recordatorio, enviados),
      'Hola Alexandra, te recuerdo que tu cita en Dento Estetic Salud Bucal *es en 2 horas* ⏰\n\n' +
        '📅 *Hoy* a las 16:00\n🦷 *Motivo:* Evaluación prótesis removible\n\n' +
        '▶️ SÍ, voy en camino\n▶️ NO podré llegar',
    );
  });

  it('posicionales, encabezado de texto en negrita, imagen y pie', () => {
    const def = {
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Hola {{1}}' },
        { type: 'BODY', text: 'Tu cita es el {{1}} a las {{2}}' },
        { type: 'FOOTER', text: 'Dento Estetic' },
      ],
    };
    const comps = [
      { type: 'header', parameters: [{ type: 'text', text: 'Ana' }] },
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'lunes' },
          { type: 'text', text: '9:00' },
        ],
      },
    ];
    assert.equal(textoDePlantilla(def, comps), '*Hola Ana*\n\nTu cita es el lunes a las 9:00\n\n_Dento Estetic_');
    const img = {
      components: [
        { type: 'HEADER', format: 'IMAGE' },
        { type: 'BODY', text: 'Sin variables' },
      ],
    };
    assert.equal(textoDePlantilla(img, []), '🖼️ (imagen)\n\nSin variables');
  });

  it('una variable que no llegó se deja a la vista, y sin definición no hay texto', () => {
    assert.equal(textoDePlantilla({ components: [{ type: 'BODY', text: 'Hola {{nombre}}' }] }, []), 'Hola {{nombre}}');
    assert.equal(textoDePlantilla(undefined, enviados), undefined);
  });

  it('el respaldo no lleva guiones bajos (el markdown de Chatwoot los lee como cursiva)', () => {
    assert.equal(respaldoDePlantilla('recordatorio_2_horas_cita'), '📄 Plantilla «recordatorio 2 horas cita»');
  });
});

describe('estructuraDePlantilla (24 oct 2026)', () => {
  // La definición real de protesis_facilidad_pago (Dento Estetic), recortada.
  const facilidad = {
    name: 'protesis_facilidad_pago',
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://scontent.whatsapp.net/ejemplo.jpg?oe=1'] } },
      { type: 'BODY', text: '¡Hola! 😊 Hace unos días nos escribiste por la prótesis removible.' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Sí, quiero mi cita' },
          { type: 'QUICK_REPLY', text: 'Tengo una duda' },
          { type: 'URL', text: 'Ver la web', url: 'https://x' },
        ],
      },
    ],
  };
  const IMG = 'https://dentoesteticsaludbucal.com/img/whatsapp/protesis-pago-en-dos-partes.jpg';

  it('la foto que se MANDÓ, no «🖼️ (imagen)», y los botones uno a uno', () => {
    const e = estructuraDePlantilla(facilidad, [{ type: 'header', parameters: [{ type: 'image', image: { link: IMG } }] }]);
    assert.deepEqual(e.encabezado, { tipo: 'imagen', enlace: IMG });
    assert.equal(e.cuerpo, facilidad.components[1].text);
    assert.deepEqual(e.botones, [
      { tipo: 'respuesta', texto: 'Sí, quiero mi cita' },
      { tipo: 'respuesta', texto: 'Tengo una duda' },
      { tipo: 'url', texto: 'Ver la web' },
    ]);
    assert.equal(e.nombre, 'protesis_facilidad_pago');
  });

  it('subida por id: el id, y para enseñarla el enlace del ejemplo (el selector de Chatwoot sube justo esa)', () => {
    const e = estructuraDePlantilla(facilidad, [{ type: 'header', parameters: [{ type: 'image', image: { id: '123' } }] }]);
    assert.deepEqual(e.encabezado, {
      tipo: 'imagen',
      id: '123',
      enlace: 'https://scontent.whatsapp.net/ejemplo.jpg?oe=1',
      deEjemplo: true,
    });
  });

  it('sin foto en lo enviado: la del ejemplo aprobado, marcada', () => {
    const e = estructuraDePlantilla(facilidad, []);
    assert.deepEqual(e.encabezado, { tipo: 'imagen', enlace: 'https://scontent.whatsapp.net/ejemplo.jpg?oe=1', deEjemplo: true });
  });

  it('las variables del cuerpo y del encabezado de texto, rellenas', () => {
    const def = {
      name: 'recordatorio',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Cita de {{1}}' },
        { type: 'BODY', text: 'Hola {{nombre}}, te esperamos' },
        { type: 'FOOTER', text: 'Dento Estetic' },
      ],
    };
    const e = estructuraDePlantilla(def, [
      { type: 'header', parameters: [{ type: 'text', text: 'Luis' }] },
      { type: 'body', parameters: [{ type: 'text', parameter_name: 'nombre', text: 'Luis' }] },
    ]);
    assert.deepEqual(e.encabezado, { tipo: 'texto', texto: 'Cita de Luis' });
    assert.equal(e.cuerpo, 'Hola Luis, te esperamos');
    assert.equal(e.pie, 'Dento Estetic');
    assert.deepEqual(e.botones, []);
  });

  it('sin definición, nada', () => {
    assert.equal(estructuraDePlantilla(undefined, []), undefined);
  });
});
