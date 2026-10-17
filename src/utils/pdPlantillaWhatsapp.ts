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
