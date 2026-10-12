// Check if the number is MX or AR
function formatMXOrARNumber(jid: string): string {
  const countryCode = jid.substring(0, 2);

  if (Number(countryCode) === 52 || Number(countryCode) === 54) {
    if (jid.length === 13) {
      const number = countryCode + jid.substring(3);
      return number;
    }

    return jid;
  }
  return jid;
}

// Check if the number is br
function formatBRNumber(jid: string) {
  const regexp = new RegExp(/^(\d{2})(\d{2})\d{1}(\d{8})$/);
  if (regexp.test(jid)) {
    const match = regexp.exec(jid);
    if (match && match[1] === '55') {
      const joker = Number.parseInt(match[3][0]);
      const ddd = Number.parseInt(match[2]);
      if (joker < 7 || ddd < 31) {
        return match[0];
      }
      return match[1] + match[2] + match[3];
    }
    return jid;
  } else {
    return jid;
  }
}

// 🔴 PARCHE PD (13 sep 2026): EL BSUID DE LA CLOUD API NO ES UN TELÉFONO.
// Meta ya no manda el teléfono de quien lo oculta: manda un *business-scoped user ID*, prefijo de
// país ISO + punto + hasta 128 alfanuméricos (`DO.937659916066542`; el del padre, `US.ENT.…`).
// `createJid` le quitaba el `DO.` y le pegaba `@s.whatsapp.net`, y en Chatwoot nacía una ficha con
// `+937659916066542` en el campo del teléfono, que no es el número de nadie (Eva Díaz, 12 sep 2026).
// Se guarda tal cual, que es como ya lo guarda Chatwoot en las fichas que llegan con BSUID.
export function esBsuid(valor: string): boolean {
  return /^[A-Z]{2}(\.ENT)?\.[A-Za-z0-9]{1,128}$/.test(String(valor || '').split('@')[0]);
}

// 🔴 PARCHE PD (12 oct 2026): A UN `@lid` NO SE LE PUEDE ESCRIBIR POR LA CLOUD API.
// Cuando el MISMO número tiene dos instancias —una por QR y otra por la Cloud API (coexistencia)—
// las dos comparten la ficha del contacto en Chatwoot, y la de QR le pone como `identifier` su
// `@lid` (`259021072289830@lid`). Al responder desde la bandeja de la Cloud API, `receiveWebhook`
// tomaba ese `identifier` como destino y la Cloud API lo mandaba al «teléfono» 259021072289830:
// Meta contestaba 131026 «Message undeliverable» y el mensaje se perdía. Pasó en Dento Estetic:
// de las dos burbujas de una respuesta del bot, la primera salió (la ficha aún tenía el teléfono)
// y la segunda no (la instancia de QR acababa de reescribir la ficha con el `@lid`).
// Un `@lid` solo sirve en la conexión que lo vio (Baileys). En la Cloud API manda el teléfono.
export function destinoDesdeChatwoot(
  remitente: { identifier?: string | null; phone_number?: string | null } | null | undefined,
  esCloudApi: boolean,
): string | undefined {
  const identificador = remitente?.identifier || undefined;
  const telefono = remitente?.phone_number ? String(remitente.phone_number).replace('+', '') : undefined;
  if (esCloudApi && identificador && identificador.includes('@lid') && telefono) {
    return telefono;
  }
  return identificador || telefono;
}

export function createJid(number: string): string {
  number = number.replace(/:\d+/, '');

  if (esBsuid(number)) {
    return number.split('@')[0];
  }

  if (
    number.includes('@g.us') ||
    number.includes('@s.whatsapp.net') ||
    number.includes('@lid') ||
    number.includes('@newsletter')
  ) {
    return number;
  }

  if (number.includes('@broadcast')) {
    return number;
  }

  number = number
    ?.replace(/\s/g, '')
    .replace(/\+/g, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .split(':')[0]
    .split('@')[0];

  if (number.includes('-') && number.length >= 24) {
    number = number.replace(/[^\d-]/g, '');
    return `${number}@g.us`;
  }

  number = number.replace(/\D/g, '');

  if (number.length >= 18) {
    number = number.replace(/[^\d-]/g, '');
    return `${number}@g.us`;
  }

  number = formatMXOrARNumber(number);

  number = formatBRNumber(number);

  return `${number}@s.whatsapp.net`;
}
