/**
 * PD (17 oct 2026): traduce las variables que rellena el agente en el selector de plantillas de
 * Chatwoot a los `components` que pide la Cloud API de Meta.
 *
 * EL PROBLEMA. El selector de Chatwoot dejó de mandar las variables «planas»
 * (`{"nombre": "Luis"}`) y las manda agrupadas por parte de la plantilla:
 *
 *   { body: { nombre: "Luis", fecha: "…" }, header: { media_url, media_type }, buttons: [ … ] }
 *
 * Evolution seguía leyéndolas planas: veía UNA variable llamada `body` y Meta rechazaba el envío
 * (`#132000 … number of localizable_params (1) does not match the expected number of params (5)`).
 * Y como el fallo volvía como respuesta y no como excepción, en el log quedaba «plantilla enviada»
 * y en Chatwoot el mensaje se veía enviado. Luis lo mandó desde la bandeja del Test Number y no le
 * llegó nada.
 *
 * Se aceptan las dos formas: la agrupada, que es la de hoy, y la plana, la de antes (8 sep 2026).
 * La conversión copia la de Chatwoot (`Whatsapp::TemplateProcessorService`), que es quien manda
 * cuando la bandeja es de WhatsApp nativo.
 */

const PARTES = ['body', 'header', 'buttons', 'footer'];

/** La forma agrupada trae al menos una de las partes, y como objeto o lista, no como texto. */
export function esFormaAgrupada(params: Record<string, any> | undefined): boolean {
  if (!params || typeof params !== 'object') return false;
  return PARTES.some((parte) => params[parte] !== undefined && typeof params[parte] === 'object');
}

/** Una clave numérica es un parámetro posicional; cualquier otra, uno con nombre. */
function parametrosDeTexto(valores: Record<string, any> | undefined): any[] {
  const pares = Object.entries(valores ?? {}).filter(
    ([, valor]) => valor !== undefined && valor !== null && `${valor}` !== '',
  );
  const posicionales = pares.every(([clave]) => /^\d+$/.test(clave));
  if (posicionales) pares.sort(([a], [b]) => Number(a) - Number(b));

  return pares.map(([clave, valor]) =>
    posicionales ? { type: 'text', text: String(valor) } : { type: 'text', parameter_name: clave, text: String(valor) },
  );
}

/**
 * El parámetro de un encabezado de imagen, video o documento. Con `media_id` (el archivo ya subido
 * al número) va por id; si no, por enlace.
 */
function parametroDeMedio(header: Record<string, any>): any | undefined {
  const tipo = String(header?.media_type || '').toLowerCase();
  const id = header?.media_id;
  const enlace = header?.media_url;
  if ((!id && !enlace) || !['image', 'video', 'document'].includes(tipo)) return undefined;

  const medio: Record<string, any> = id ? { id: String(id) } : { link: enlace };
  if (tipo === 'document' && header.media_name) medio.filename = header.media_name;

  return { type: tipo, [tipo]: medio };
}

/**
 * Los `components` de Meta a partir de lo que mandó Chatwoot. Devuelve `[]` si la plantilla no
 * lleva nada que rellenar (una plantilla de texto fijo se manda sin componentes).
 */
export function componentesDePlantilla(params: Record<string, any> | undefined): any[] {
  if (!params || !Object.keys(params).length) return [];

  if (!esFormaAgrupada(params)) {
    const parameters = parametrosDeTexto(params);
    return parameters.length ? [{ type: 'body', parameters }] : [];
  }

  const componentes: any[] = [];

  if (params.header && typeof params.header === 'object') {
    const esMedio = 'media_url' in params.header || 'media_type' in params.header;
    const parameters = esMedio ? [parametroDeMedio(params.header)].filter(Boolean) : parametrosDeTexto(params.header);
    if (parameters.length) componentes.push({ type: 'header', parameters });
  }

  const cuerpo = parametrosDeTexto(params.body);
  if (cuerpo.length) componentes.push({ type: 'body', parameters: cuerpo });

  if (Array.isArray(params.buttons)) {
    params.buttons.forEach((boton: any, index: number) => {
      if (!boton || !boton.parameter) return;
      const tipo = String(boton.type || 'url').toLowerCase();
      componentes.push(
        tipo === 'copy_code'
          ? {
              type: 'button',
              sub_type: 'copy_code',
              index,
              parameters: [{ type: 'coupon_code', coupon_code: String(boton.parameter) }],
            }
          : { type: 'button', sub_type: 'url', index, parameters: [{ type: 'text', text: String(boton.parameter) }] },
      );
    });
  }

  return componentes;
}

/**
 * ¿Hay que pedirle a Meta la imagen del encabezado? Sí cuando el agente no puso ninguna, o cuando
 * la que viene es la del EJEMPLO de la plantilla: Meta la sirve desde `scontent.whatsapp.net` con
 * una firma que caduca (`oe=`, unos 30 días), así que la guardada en Chatwoot deja de valer sola.
 * 🔴 Y ese enlace NO vale para enviar aunque esté vigente: Meta no se lo descarga a sí misma
 * (medido el 17 oct: `131053 … Downloading media from weblink failed with http code 403`). Por eso
 * Evolution lo descarga, lo sube al número (`/<número>/media`) y manda la plantilla con el id.
 */
export function pideImagenDeEjemplo(params: Record<string, any> | undefined): boolean {
  if (!esFormaAgrupada(params)) return false;
  const header = params.header;
  if (!header || !('media_type' in header || 'media_url' in header)) return false;

  const enlace = String(header.media_url || '');
  if (!enlace) return true;

  try {
    const { hostname } = new URL(enlace);
    return /(^|\.)(whatsapp\.net|fbcdn\.net|fbsbx\.com)$/.test(hostname);
  } catch {
    return true;
  }
}

/** El texto del error de Meta, legible, para enseñarlo en Chatwoot. */
export function errorDeMeta(respuesta: any): string {
  const detalle = respuesta?.error_data?.details;
  const mensaje = respuesta?.message || respuesta?.error?.message;
  return [mensaje, detalle].filter(Boolean).join(' — ') || 'Meta no aceptó la plantilla';
}

/**
 * PD (19 oct 2026): EL TEXTO REAL DE UNA PLANTILLA ENVIADA, para guardarlo y para Chatwoot.
 *
 * Por la Cloud API, `sendTemplate` guardaba solo `▶️<nombre>◀️`, y eso era lo que llegaba a
 * Chatwoot. Luis vio en la conversación de una paciente «▶️recordatorio2horas_cita◀️» en vez del
 * recordatorio de 2 horas: el nombre, y encima con los guiones bajos comidos, porque el markdown de
 * Chatwoot lee `_2_` como cursiva. Nadie del equipo podía saber qué se le había dicho a la paciente.
 *
 * Aquí se arma con la definición que da Meta (`/<waba>/message_templates`) y los `components` que se
 * mandaron: encabezado de texto en negrita, cuerpo y pie con sus variables rellenas (posicionales
 * `{{1}}` y con nombre `{{nombre}}`) y los botones, uno por línea. Se escribe en formato de WhatsApp:
 * la traducción al markdown de Chatwoot la hace después `aMarkdownDeChatwoot`.
 * Devuelve `undefined` si no hay definición: quien llama pone entonces `respaldoDePlantilla`.
 */
export function textoDePlantilla(definicion: any, componentes: any[] | undefined): string | undefined {
  if (!definicion || !Array.isArray(definicion.components)) return undefined;

  const enviado = (tipo: string) =>
    (Array.isArray(componentes) ? componentes : []).find((c: any) => String(c?.type || '').toLowerCase() === tipo);

  const valorDe = (p: any): string | undefined => {
    if (!p) return undefined;
    const valor = p.text ?? p.currency?.fallback_value ?? p.date_time?.fallback_value;
    return valor === undefined || valor === null ? undefined : String(valor);
  };

  const rellenar = (texto: string, componente: any): string => {
    const parametros: any[] = Array.isArray(componente?.parameters) ? componente.parameters : [];
    return String(texto).replace(/\{\{\s*(\w+)\s*\}\}/g, (marca, clave) => {
      const p = /^\d+$/.test(clave)
        ? parametros[Number(clave) - 1]
        : parametros.find((x: any) => x?.parameter_name === clave);
      return valorDe(p) ?? marca;
    });
  };

  const bloques: string[] = [];
  let botones: string[] = [];

  for (const parte of definicion.components) {
    const tipo = String(parte?.type || '').toUpperCase();
    if (tipo === 'HEADER') {
      const formato = String(parte.format || 'TEXT').toUpperCase();
      if (formato === 'TEXT' && parte.text) bloques.push(`*${rellenar(parte.text, enviado('header')).trim()}*`);
      else if (formato === 'IMAGE') bloques.push('🖼️ (imagen)');
      else if (formato === 'VIDEO') bloques.push('🎬 (vídeo)');
      else if (formato === 'DOCUMENT') bloques.push('📄 (documento)');
      else if (formato === 'LOCATION') bloques.push('📍 (ubicación)');
    } else if (tipo === 'BODY' && parte.text) {
      bloques.push(rellenar(parte.text, enviado('body')));
    } else if (tipo === 'FOOTER' && parte.text) {
      bloques.push(`_${String(parte.text).trim()}_`);
    } else if (tipo === 'BUTTONS' && Array.isArray(parte.buttons)) {
      const icono: Record<string, string> = { URL: '🔗', PHONE_NUMBER: '📞', COPY_CODE: '📋' };
      botones = parte.buttons
        .filter((b: any) => b?.text)
        .map((b: any) => `${icono[String(b.type || '').toUpperCase()] || '▶️'} ${b.text}`);
    }
  }

  if (!bloques.length) return undefined;
  if (botones.length) bloques.push(botones.join('\n'));
  return bloques.join('\n\n');
}

/**
 * PD (24 oct 2026): LA PLANTILLA ENVIADA COMO SE VE EN EL TELÉFONO, para el chat del Manager.
 *
 * `textoDePlantilla` la deja en texto: la foto del encabezado como «🖼️ (imagen)» y los botones como
 * «▶️ Sí, quiero mi cita». Luis lo vio en la conversación de un paciente con la plantilla del
 * seguimiento de 72 h: *«no se veía la imagen, decía en texto imagen… debe haberse visto el mensaje
 * completo»*. Esto guarda las partes por separado —el encabezado con el enlace o el id de la foto
 * que se mandó, el cuerpo con sus variables rellenas, el pie y los botones— en `message.pdPlantilla`,
 * AL LADO del `conversation` de siempre, que siguen leyendo Chatwoot, n8n y los bots.
 *
 * La foto sale de lo enviado (`components` → header → image.link o image.id); si no viene, del
 * ejemplo aprobado de la definición (`example.header_handle`, un enlace de Meta que caduca).
 */
export function estructuraDePlantilla(
  definicion: any,
  componentes: any[] | undefined,
  nombre?: string,
): Record<string, any> | undefined {
  if (!definicion || !Array.isArray(definicion.components)) return undefined;

  const enviado = (tipo: string) =>
    (Array.isArray(componentes) ? componentes : []).find((c: any) => String(c?.type || '').toLowerCase() === tipo);

  const valorDe = (p: any): string | undefined => {
    if (!p) return undefined;
    const valor = p.text ?? p.currency?.fallback_value ?? p.date_time?.fallback_value;
    return valor === undefined || valor === null ? undefined : String(valor);
  };

  const rellenar = (texto: string, componente: any): string => {
    const parametros: any[] = Array.isArray(componente?.parameters) ? componente.parameters : [];
    return String(texto).replace(/\{\{\s*(\w+)\s*\}\}/g, (marca, clave) => {
      const p = /^\d+$/.test(clave)
        ? parametros[Number(clave) - 1]
        : parametros.find((x: any) => x?.parameter_name === clave);
      return valorDe(p) ?? marca;
    });
  };

  const estructura: Record<string, any> = { nombre: nombre || definicion.name, botones: [] };
  const TIPOS_DE_MEDIO: Record<string, string> = { IMAGE: 'imagen', VIDEO: 'video', DOCUMENT: 'documento' };
  const TIPOS_DE_BOTON: Record<string, string> = { URL: 'url', PHONE_NUMBER: 'telefono', COPY_CODE: 'codigo' };

  for (const parte of definicion.components) {
    const tipo = String(parte?.type || '').toUpperCase();
    if (tipo === 'HEADER') {
      const formato = String(parte.format || 'TEXT').toUpperCase();
      if (formato === 'TEXT' && parte.text) {
        estructura.encabezado = { tipo: 'texto', texto: rellenar(parte.text, enviado('header')).trim() };
      } else if (TIPOS_DE_MEDIO[formato]) {
        const clave = formato.toLowerCase();
        const medio = (enviado('header')?.parameters ?? []).find((p: any) => p?.[clave])?.[clave] ?? {};
        const ejemplo = parte.example?.header_handle?.[0];
        estructura.encabezado = {
          tipo: TIPOS_DE_MEDIO[formato],
          ...(medio.link ? { enlace: String(medio.link) } : {}),
          ...(medio.id ? { id: String(medio.id) } : {}),
          ...(!medio.link && ejemplo ? { enlace: String(ejemplo), deEjemplo: true } : {}),
        };
      } else if (formato === 'LOCATION') {
        estructura.encabezado = { tipo: 'ubicacion' };
      }
    } else if (tipo === 'BODY' && parte.text) {
      estructura.cuerpo = rellenar(parte.text, enviado('body'));
    } else if (tipo === 'FOOTER' && parte.text) {
      estructura.pie = String(parte.text).trim();
    } else if (tipo === 'BUTTONS' && Array.isArray(parte.buttons)) {
      estructura.botones = parte.buttons
        .filter((b: any) => b?.text)
        .map((b: any) => ({
          tipo: TIPOS_DE_BOTON[String(b.type || '').toUpperCase()] || 'respuesta',
          texto: String(b.text),
        }));
    }
  }

  if (!estructura.encabezado && !estructura.cuerpo && !estructura.botones.length) return undefined;
  return estructura;
}

/** Si Meta no da la definición: al menos el nombre, sin guiones bajos que el markdown se coma. */
export function respaldoDePlantilla(nombre: string): string {
  return `📄 Plantilla «${String(nombre || '')
    .replace(/_/g, ' ')
    .trim()}»`;
}
