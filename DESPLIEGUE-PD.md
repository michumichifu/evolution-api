# La rama `deploy/parches-pd` (Proyección Digital)

**Esto no es un fork con vida propia: es el tag `2.4.0-rc2` con los parches que corren en nuestra
VPS2**, ni uno más. Si hace falta tocar el backend de Evolution, se toca **aquí**, se commitea, se
compila y se despliega. **Nunca se edita el `dist` del servidor a mano** (ya pasó una vez, el 3 sep
2026, y por eso existe este documento).

## Qué lleva encima del tag

| Commit | Qué arregla |
|---|---|
| `fix(baileys): clear stale credentials when a 401 closes the initial connection` | Una instancia que perdía la sesión **no podía generar un QR nuevo nunca más**: conservaba la identidad en las credenciales y Baileys intentaba reautenticarse en vez de parear, en bucle. Es el PR [#2680](https://github.com/evolution-foundation/evolution-api/pull/2680) aguas arriba. |
| `fix(baileys): retire the previous socket before creating a new one` | Dos sockets con las mismas credenciales se expulsaban entre sí (`conflict: replaced`, 440) en un bucle infinito. Ver abajo. |
| `fix(chatwoot): el cliente del SDK no tiene .get ni .post` (`11d8c436`, 5 sep 2026) | **Ningún identificador `@lid` se resolvía nunca.** `findContactByIdentifier` llamaba a `(client as any).get('contacts/search')` y `(client as any).post('contacts/filter')`, y el `ChatwootClient` del SDK de `@figuro` **no tiene métodos HTTP genéricos**: el `as any` era lo único que dejaba compilarlo. Reventaba siempre con `TypeError: t.get is not a function`, y el `catch` de `resolveLidToPhone` lo tragaba como un `warn`. Ver abajo. |
| `fix(chatwoot): traducir el formato de WhatsApp también en los botones` (`c21a3193`, 8 sep 2026) | **El título de un mensaje con botones salía en cursiva, no en negrita.** WhatsApp escribe `*negrita*`; **Chatwoot pinta con markdown-it, donde `*x*` es CURSIVA** y la negrita es `**x**`. El flujo normal ya traducía, pero el camino de los botones **crea su propio mensaje y se lo saltaba**. Ver abajo. |
| `fix(chatwoot): mostrar los botones interactivos, no solo el PIX` (`7ec44c20`, 8 sep 2026) | **Un mensaje con botones (`sendButtons`) no aparecía en Chatwoot.** El bloque `isInteractiveButtonMessage` de upstream **solo mapea un caso, el PIX brasileño**; cualquier otro botón —`quick_reply`, `cta_url`— caía en un `else` que se limitaba a escribir «Interactive Button Message not mapped», **una vez por botón**, porque el bucle recorre botones y no mensajes. Ver abajo. |
| `fix(chatwoot): que se vean las plantillas y las respuestas a botones` (`31b4c4c5`, 8 sep 2026) | **Se mandaba una plantilla y en la bandeja no aparecía nada.** Llega como `templateMessage`, con el texto dentro de `interactiveMessageTemplate`, y `getTypeMessage` no lo contemplaba: se descartaba con un WARN **«no body message found»**. Igual con la respuesta del usuario a un botón (`templateButtonReplyMessage`, `buttonsResponseMessage`, `interactiveResponseMessage`). Lleva además **dos parches que estaban solo en el `main.js` del servidor** — ver abajo. |
| `feat(chatwoot): guardar el usuario de WhatsApp de quien oculta su número` (`aa770124`, 5 sep 2026) | Quien esconde su número llega **sin teléfono**, solo con el `@lid`, y acababa guardado como `+105828497510423`, que no es ningún número. Ahora se guardan además `whatsapp_usuario` y `whatsapp_lid` en los atributos del contacto. Ver abajo. |
| `fix(chatwoot): un @lid sin numero alternativo perdia el mensaje entero` (`3240bbc9`, 9 sep 2026) | **1.021 mensajes de Zenithe y Dental Shine no llegaron NUNCA a Chatwoot** entre el 3 y el 9 de septiembre — medido cruzando el `key.id` de cada uno contra el `source_id`, y con su control: los mensajes normales de las mismas instancias y los mismos días entraron 581 de 696. `createConversation` arranca con `phoneNumber = body.key.remoteJidAlt`; cuando WhatsApp no manda ese número **y** el LID tampoco se resuelve, eso sigue `undefined` hasta el `phoneNumber.split('@')[0]` de trece líneas más abajo, que revienta con «Cannot read properties of undefined (reading 'split')». El `catch` lo dejaba en un `warn`: **166 errores en 7 h, todo en verde**. 🔴 **No lo cubría `11d8c436`**, que arregló que el LID *se resolviera*; este es el camino de **cuando no se puede**. Ahora se cae al propio `@lid` y el mensaje llega. Lleva además que `whatsapp_usuario` y `whatsapp_lid` se guarden **también cuando el LID sí trae teléfono**, a petición de Luis. |
| `fix(lid): la misma persona no puede ser dos chats` (`500baf99`, 10 sep 2026) | **Una persona salía dos veces en el chat del Manager**: con su teléfono y con su `@lid` como si fuera un número. WhatsApp manda a veces el mensaje sin `sender_pn` y Baileys deja `remoteJidAlt` vacío, pero **el par está en el mapa de Baileys** (Redis, `evolution:instance:<id>` → `lid-mapping-<lid>_reverse`) y aquí solo se consultaba en las llamadas. Además el cambio `@lid` → teléfono de `messages.upsert` iba **después** del `message.create` y de Chatwoot: solo lo veía el webhook. `resolverTelefonoDeLid` lo hace tras `prepareMessage` al recibir, al enviar y en el historial, y los no leídos se cuentan en ese chat. Desplegado el 10 sep 2026 a las 23:13 UTC, con respaldo en `/root/respaldos/evolution-dist-parcheado-20260911-0112-pre-resolverlid.tgz`. 🔴 **Al hacer `rsync --delete` se excluyen los `main.js.bak-*`** que dejó root en el `dist`, o se borran. |
| `fix(lid): el usuario de un saliente llega a la ficha, y el chat carga en 15 ms` (`a34e2b5e`, 13 sep 2026) | **El usuario de WhatsApp llegaba y la ficha de Chatwoot se quedaba sin él** (Eva Díaz, `@evamariadm`): la puesta al día estaba dentro de `if (!fromMe)` y detrás del atajo de la caché, y el usuario solo viaja en salientes. `sincronizarUsuarioWa` va antes de la caché. Y **`fetchChats` pasa de 2.361 ms a 15 ms** con un `GROUP BY` de una pasada: las subconsultas se evaluaban por cada mensaje. Desplegado con `main.js.bak-20260913-pre-usuario-bsuid`. |
| `fix(cloud-api): el BSUID no es un telefono, y el usuario de Meta se guarda` (`314e57b2`, 13 sep 2026) | **`DO.937659916066542` acababa en Chatwoot como el teléfono `+937659916066542`.** `esBsuid()` en `createJid`, Chatwoot lo busca y crea por identificador, el envío usa `recipient` en vez de `to`, y `contacts[0].profile.username` va a `key.remoteJidUsername`. Mismo despliegue que el anterior. |
| `fix(chatwoot): reconocer a la persona por su @lid o su @usuario guardados` (`2ca3c49c`, 13 sep 2026) | **La misma persona abría una segunda conversación** cuando WhatsApp la mandaba con su `@lid` en vez del teléfono. Antes de crear ficha y conversación, `buscarPorAtributoWa` busca por `whatsapp_lid` y `whatsapp_usuario` (solo si casa UNA ficha exacta). Desplegado con `main.js.bak-20260913-pre-buscar-por-lid`; md5 en producción `6eeb2cc6cdac02e1254b86366ef89425`. |
| `fix(perfil): el nombre y la foto de la cuenta se piden en vivo, no al conectar` (`8f7c6bff` + `5328d72e`, 14 sep 2026) | **El botón «Actualizar» del Manager no actualizaba nada**: el Manager releía `fetchInstances`, que lee la base, y la base solo recibe `profileName` y `profilePicUrl` **al conectar** —el nombre, copiado del `me.name` de la sesión guardada—. Un nombre cambiado en el teléfono no llegaba nunca, y aunque se reconectara cien veces se volvía a escribir el viejo. **`POST /instance/refreshProfiles`** (sin `instanceName`; opcional `{instanceNames: []}`): en QR, `refreshOwnProfile()` resincroniza `critical_block` —la colección donde WhatsApp guarda `pushNameSetting`— y pide la foto; en Cloud API pide a Meta `verified_name`, `name_status` y `profile_picture_url`. Guarda lo que cambie y devuelve antes/después por instancia. Además, **cada `creds.update` con `me.name` guarda el nombre en el momento**. 🔴 **`5328d72e` es la trampa de siempre**: una ruta nueva sin `instanceName` hay que añadirla a la lista de `instanceExistsGuard`, o contesta **400 «instanceName not provided»** sin llegar al controlador — igual que les pasó a `restorableSessions` y `restoreSessions`. 🔴 **`name_status` NO dice si hay un nombre nuevo: es el estado del nombre ACTUAL.** PD Cloud da `PENDING_REVIEW` **sin ningún cambio pedido** (lo confirmó Luis), y la primera versión lo leyó como «nombre nuevo en revisión» y lo avisó en el Manager. El campo bueno es **`new_name_status`** (`NONE` = no hay cambio). 🔴 **Y la URL de la foto cambia en CADA petición** (firma `oh` y caducidad `oe`): comparar URLs daba «actualizada» con la misma foto (Mundo Veneco y Dentistica, 14 sep). Se compara el **id de archivo** de la ruta. Los dos, corregidos en el tercer commit. ⚠️ **Probado en producción**: 200 en 6 s, 9 instancias, 0 errores, 0 conflictos tras el reinicio. 🔴 **Y AUN ASÍ NO VEÍA EL CAMBIO DE LUIS, y se le dijo que WhatsApp no lo tenía: era falso** (`8be5fbfb`). En una cuenta **WhatsApp Business** el nombre que ve la gente es el **nombre de empresa**, y ese **no está en `pushNameSetting` ni en `fetchBusinessProfile`**: es el **certificado de nombre verificado**, que se pide con `<iq xmlns="w:biz" type="get"><verified_name jid="…"/></iq>` y se decodifica con `proto.VerifiedNameCertificate` (lo mismo que Baileys hace con `verifiedBizName` de un mensaje entrante). Mundo Veneco: `pushName` «Luis Duran - Trafficker Digital» y `verifiedName` **«Luis Rangel - Estratega y Publicidad»**, el nombre nuevo. `refreshOwnProfile()` le da prioridad y `refreshProfiles` devuelve `whatsapp: {pushName, verifiedName}` por instancia. ⚠️ Una cuenta NO Business (Luis Personal) responde `item-not-found` y deja un `warn`: es esperado. **Si alguien puede señalar el dato cambiado en el teléfono, el que mira mal es el método**. Respaldo previo en `/root/dist-parcheado-respaldo-20260914-pre-refreshprofiles.tgz`. |
| `fix(cloud-api): guardar de qué anuncio viene quien escribe (referral → externalAdReply)` (`a3e2293d`, 27 sep 2026) | **El anuncio de origen se perdía en la Cloud API.** Meta manda en el primer mensaje de un anuncio de clic a WhatsApp un `referral` (`source_url`, `source_id`, `headline`, `body`, `media_type`, `image_url`/`video_url`/`thumbnail_url`, `ctwa_clid` y `welcome_message.text`; doc: `…/whatsapp/webhooks/reference/messages/text.md`) y `messageHandle` lo tiraba. **`anuncioDeReferral()`** lo guarda en `messageRaw.contextInfo.externalAdReply` con los nombres de Baileys (`title`, `body`, `thumbnailUrl`, `mediaUrl`, `sourceUrl`, `sourceId`, `ctwaClid`, `greetingMessageBody`), así que la tarjeta de anuncio de la integración con Chatwoot (`getAdsMessage`), el chat del Manager y el webhook a n8n lo recogen igual en los dos canales. La tarjeta de Chatwoot lleva ahora la **bienvenida**, y 🔴 **ya no tira el mensaje entero si la miniatura no viene o no baja** (antes un `return` sin enviar nada): se manda sin imagen. ⚠️ **Los mensajes anteriores NO se recuperan**: el dato nunca se guardó. Desplegado el 27 sep 06:35 CEST, 9 instancias igual antes y después del reinicio, 0 errores. El `rsync` excluyó `main.js.bak-*` **y `@types/`** (4 restos de una compilación vieja que el compilado actual no produce). Respaldo: `/root/dist-parcheado-respaldo-20260927-pre-anuncio.tgz`. |
| `fix(cloud-api): esperar a loadChatwoot antes de procesar el mensaje` (`0d29834f`, 27 sep 2026) | 🔴 **El PRIMER mensaje tras reiniciar Evolution no llegaba a Chatwoot en las instancias Cloud API.** `connectToWhatsapp` llamaba a `this.loadChatwoot()` **sin `await`**: el primer webhook después del arranque encontraba `localChatwoot` vacío, se saltaba el `eventWhatsapp` **sin dejar ni una línea en el log** (ni el habitual `New message received`), y el mensaje quedaba en la base de Evolution pero no en la bandeja. Salió en la primera prueba real con anuncio (04:45 UTC, justo después del reinicio del despliegue anterior): **el anuncio se guardó bien y el mensaje no apareció en Chatwoot**; las respuestas de Marie, un minuto después, sí. **Es del Evolution original y le pasaba en cada reinicio.** Desplegado a las 06:5x CEST, instancias igual antes y después. |
| `fix(chatwoot): la imagen del anuncio entera y la red de la que viene` (`a30f8631`, 27 sep 2026) | La tarjeta de anuncio **recortaba la miniatura a 320×180** con `Jimp.cover` (Luis: *«se ve como un banner»*): ahora va entera, solo achicada si pasa de 800 px. ⚠️ **La Cloud API manda una miniatura YA cuadrada de 306 px** (`stp=c3.41.300.300a…p306x306` en la URL): el 4:5 original no viaja en el mensaje. Y la tarjeta dice **«Desde un anuncio de Facebook/Instagram»** con el criterio de la tarjeta de WhatsApp: `entryPointConversionApp` (QR) o el enlace (`fb.me`/facebook.com → Facebook, instagram.com → Instagram). Ni WhatsApp lo sabe seguro: encima del chat pone «a partir de un anuncio en Facebook **o** Instagram». |
| `fix(chatwoot): la copia de lo que envía un bot por la API sale a nombre de su Agent Bot` (`02557f69`, 27 sep 2026) | La nota de voz de Marie (que se envía por `sendWhatsAppAudio`) aparecía en Chatwoot **a nombre de «José Rangel Admin»**, el dueño del token de la integración. Ahora, si el cuerpo trae **`pdFirmaChatwoot`** (el `access_token` del Agent Bot), `audioWhatsapp` lo pasa en las opciones, `sendMessageWithTyping` lo pone en `messageRaw` **solo mientras se crea la copia** (después del aviso `SEND_MESSAGE` y antes de guardar y responder, donde se borra) y `sendData` lo usa como `api_access_token`. El esquema del audio no tiene `additionalProperties: false`, así que el campo pasa. Solo afecta a quien lo manda: sin él, todo sigue igual. El flujo de Marie lo manda desde `[CA] Voz por Evolution` (versión `a8f734b7`). Respaldo: `/root/dist-parcheado-respaldo-20260927-pre-firma.tgz`. |
| `fix(chatwoot): reintenta la miniatura del anuncio…` (`f9042a1c`) y `…plan B de la miniatura del anuncio…` (`45474dfa`), 28 sep 2026 | 🔴 **3 de 15 tarjetas de anuncio del 27 sep llegaron a Chatwoot SIN imagen** (en el Manager sí se veía). Dos causas: **(1)** un corte momentáneo con el CDN de Facebook (`AggregateError`; la misma URL bajaba bien minutos después) y un solo intento; **(2)** Meta a veces manda un enlace de otro tipo (`/o1/v/t4/f2/m503/…`) que **su propio CDN rechaza con 400 aunque no haya caducado** (`oe` en el futuro; 2 de 15, del mismo anuncio que en los otros mensajes traía un `/v/t45.1600-4/…` que baja). Ahora: **tres intentos** (1,5 s y 3 s de espera, 10 s de límite; un 4xx no se reintenta) y, si no baja, **plan B: la miniatura de otro mensaje del mismo anuncio** (`contextInfo.externalAdReply.sourceId`, los 10 más recientes de la instancia, hasta 3 URL distintas). `mediaUrl` no sirve de plan B: en la Cloud API es la misma URL que `thumbnailUrl` (14 de 14). La consulta de Prisma por ruta JSON se probó en el contenedor contra la base real (10 resultados). Desplegado 02:5x CEST del 28 sep, instancias igual antes y después. Respaldo: `/root/dist-parcheado-respaldo-20260928-0251.tgz`. |
| `fix(cloud-api): guardar también los audios, fotos y documentos que llegan (sin S3)` (`7852b4e5`, 27 sep 2026) | 🔴 **Ningún archivo recibido por la Cloud API existía en la base de Evolution.** `messageHandle` guardaba solo `!isMediaMessage && type !== 'sticker'`; un archivo se guardaba únicamente dentro de la rama de S3, y aquí S3 está apagado. Su chat enseñaba solo el texto (Luis, con un paciente que mandaba notas de voz). Ahora, sin S3, se guarda todo, y los archivos **sin el base64** (la referencia de Meta basta): el Manager lo pide con `getBase64FromMediaMessage`, que lo descarga de Meta por su id (unos 30 días). Con S3 no cambia nada. Lo anterior no se recupera. Respaldo: `/root/dist-parcheado-respaldo-20260927-pre-archivos.tgz`. |
| `feat(chatwoot): el estado de entrega (entregado, leído, fallido) llega a Chatwoot` (`37ea5132`, 27 sep 2026) | 🔴 **Nada de lo enviado desde Chatwoot pasaba de «enviado».** Las bandejas son de tipo API, y ahí Chatwoot pinta el check con el `status` del mensaje, que pone el sistema externo; Evolution guardaba los estados (de Meta en Cloud API y de WhatsApp por QR) en `MessageUpdate` y **no se los pasaba**. `actualizarEstadoEnChatwoot()` los manda por la **API oficial** (`PATCH /api/v1/accounts/:a/conversations/:c/messages/:m`, `{status}` y `external_error` si falla; solo bandejas API), desde el manejo de `statuses` de la Cloud API y desde `messages.update` de Baileys. Mapa: `DELIVERY_ACK`/`DELIVERED` → delivered, `READ`/`PLAYED` → read, `FAILED`/`ERROR` → failed; «sent» no se manda, y Chatwoot no deja bajar de read a delivered. Si el enlace aún no existe (el primer aviso llega antes de que se enlace lo enviado desde Chatwoot), reintenta a los 3 s. Y lo enviado por la **API de Evolution** guarda ahora `chatwootMessageId`/`ConversationId` (se espera a Chatwoot, con tope de 20 s), para recibir también su estado. 🔴 **NO es el `Error updating Chatwoot message source ID: ENOTFOUND host`**, que sigue: ese sale de la conexión directa a la base de Chatwoot (`CHATWOOT_IMPORT_DATABASE_CONNECTION_URI` sin poner, usa la de ejemplo con host `host`); arreglarlo enciende de verdad `importContacts`, `importMessages` y el cron `syncLostMessages`, que duplicaría lo enviado desde Chatwoot sin `WAID`. **No hace falta para los checks.** Probado a mano: `PATCH` → 200 y el 419556 pasó a `read`. Respaldo: `/root/dist-parcheado-respaldo-20260927-pre-estados.tgz`. |
| `fix: comandos del bot sin enviar al paciente, y notas de voz ogg por Cloud API` (`226eb28d`, 27 sep 2026) | 🔴 **Un comando del bot escrito en Chatwoot le llegaba al paciente** desde que la bandeja 82 entrega por Evolution. Luis: *«originalmente uno escribe en la conversación y se activaba o desactivaba y no le salía al paciente en su WhatsApp»*. `receiveWebhook` ya no envía un saliente que es **solo** un comando (`/^\s*#[a-z0-9áéíóúñ-]+(\s+\+?[\d\s-]{7,20})?\s*$/i`, sin adjuntos): `#pausa`, `#pausa 18091234567`, `#lista`… sí; «Hola #pausa» o «el #martes», no. El flujo lo sigue leyendo por el webhook de cuenta. Vale para todas las instancias. **Notas de voz por Cloud API:** `processAudio` subía todo audio en base64 como `.mp3` **y sin tipo** (el `mimetype` se ponía después de subirlo); un ogg (base64 que empieza por `T2dnUw`) va ahora como `audio/ogg` y el envío lleva **`voice: true`** (nota de voz de verdad: micrófono, foto, descarga automática y transcripción; doc de Meta «Audio messages»). Y `getBase64FromMediaMessage` acepta `mimetype` además de `mime_type`: sin eso la nota enviada llegaba a Chatwoot sin tipo. Respaldo: `/root/dist-parcheado-respaldo-20260927-pre-voz-comandos.tgz`. |
| `feat(chatwoot): el anuncio viaja en pd_anuncio para que el fork lo pinte como en WhatsApp` (`f896a03f`, 27 sep 2026) | Luis quiere la tarjeta **en el orden del teléfono**: rótulo «Mensaje a partir de un anuncio», la tarjeta del anuncio y, debajo, el mensaje. Chatwoot no deja ordenar imagen y texto dentro de un mensaje, así que el anuncio viaja además en **`content_attributes.pd_anuncio`** (`red`, `titulo`, `texto`, `enlace`, `bienvenida`, `mensaje`, `adjunto`) y **el fork de Chatwoot lo pinta** (`WhatsappAnuncio.vue`, `a064c733c` de `chatwoot-pd`), igual que `pd_interactivo`. El `content` sigue llevando todo en texto, ya en ese orden, para el correo de aviso, el buscador y cualquier cliente que no sea el fork. `sendData` acepta atributos propios (`atributosExtra`) y `createMessage` el anuncio (caso sin imagen). |
| `feat(cloud-api): el estado real del número según Meta, aparte de connectionStatus` (`121df539` + `ff64f8da`) y `…qué tipo de desconexión fue, desde cuándo, y los avisos de cuenta de Meta` (`6232c833`), 3 oct 2026; pruebas en `1bfbdd81` y `6232c833` | 🔴 **Una instancia Cloud API salía «Conectado» SIEMPRE**: `BusinessStartupService.stateConnection` es `{ state: 'open' }` fijo. «Zenithe 2 - Cloud Api» llevaba desde el 30 sep 23:18 RD **fuera de internet** en el Business Manager y con la app sin acceso (Graph: code 100, subcode 33), y nadie se enteró en dos días. Luis: *«tiene que indicar realmente que esa instancia está desconectada, no aparecer conectado como sale actualmente»*. Ahora el backend le pregunta a Meta por cada número (`salud-meta.ts` + `salud-meta.service.ts`), guarda el resultado **aparte** y `fetchInstances` lo devuelve. **Todo en el apartado de abajo**, «El estado real de una Cloud API según Meta». 🟢 **Desplegado el 3 oct 2026, 03:31 RD** (`eeb7bb48`; respaldo `/root/dist-parcheado-respaldo-20261003-0929-pre-salud-meta.tgz`; 823 archivos en el servidor = 815 + las 8 copias `main.js.bak-*`). Comprobado: «PD Cloud» → `CONNECTED`, «Zenithe 2 - Cloud Api» → `NO_ACCESS` 100/33 y `connectionStatus: close` solo en la respuesta (la base sigue `open`). |
| `fix(webhook): el token de Meta de una Cloud API no viaja en el sobre` (`415cf261`, 8 oct 2026) | 🔴 **Otra vez un parche que vivía solo en el servidor.** José Luis cambió el 7 oct a las 14:34 RD el `main.js` y el `main.mjs` de `dist-parcheado` a mano (respaldos `main.js.bak-20261007-183438-pre-sin-token-meta` y `main.mjs.bak-…`): en una instancia Cloud API la «apikey» de la instancia **es el token de Meta** (empieza por `EAA`), el sobre de `sendDataWebhook` lo llevaba en `apikey` y **n8n lo guardaba en cada ejecución**. Él mismo lo avisó: *«si se vuelve a generar dist-parcheado desde el código fuente, ese cambio se pierde»*. Portado al fuente como `esTokenDeMeta()` (`vinculacion.ts`) antes de desplegar lo de abajo; **sin este commit el `rsync` lo habría borrado**. Las instancias por QR siguen enviando su llave, porque el flujo de Luisa la usa. 🔴 El `rsync` excluye ahora también **`main.mjs.bak-*`**. |
| `fix(vinculacion): logout ya no impide vincular, y pedir el otro tipo cierra la generación` (`9e16a982`) y `…las credenciales a medias de un código se borran antes de abrir otra generación` (`997f61ee`), 8 oct 2026 | 🔴 **Vincular un número costó 67 minutos y diez intentos con una clienta al teléfono** (Dento Estetic, la noche del 7 al 8 oct). Cuatro fallos, **todos en el apartado de abajo**, «Vincular por QR o por código». En corto: **(1)** `createClient` repone `isDeleting`, que `logoutInstance()` ponía a `true` para siempre (el teléfono aceptaba la vinculación, llegaba el `515` y aquí se saltaba la reconexión; **documentado desde el 7 ago y sin arreglar**); **(2)** `/instance/connect` con una generación del otro tipo en curso la cierra y abre la pedida (antes: `pairingCode: null` y el Manager girando); **(3)** `/instance/restart` en mitad de una generación la corta; **(4)** las credenciales a medias que deja `requestPairingCode` (`creds.me` sin `creds.account`) se borran antes de abrir otra generación (si no, **401**). 🟢 **Desplegado el 8 oct 2026, 02:22 RD** (`997f61ee`, md5 del `main.js` `cd5960bf26ac1ffeae31e01be0a7eeb7`; respaldo `/root/dist-parcheado-respaldo-20261008-0815-pre-vinculacion.tgz`; **829 archivos** en el servidor = 819 + 10 respaldos). Las 11 instancias, igual antes y después de los dos reinicios; 0 errores, 0 conflictos. |

## 🔴 EL 8 DE SEPTIEMBRE DE 2026 HABÍA DOS PARCHES SOLO EN EL SERVIDOR

Al ir a desplegar, el `dist` de producción tenía **805 archivos y el compilado 803**. Los dos de más
eran **respaldos del propio `main.js`**, con la fecha dentro del nombre:

```
main.js.bak-20260908-0205-pre-bsuid
main.js.bak-20260908-0216-pre-fromuserid
```

Alguien había **editado el `main.js` a mano en la VPS2** esa madrugada, justo lo que este documento
prohíbe. Los dos cambios eran buenos y **no estaban en el repo**:

1. Aceptar `from_user_id` / `contacts[0].user_id` / `recipient_user_id` cuando el usuario **oculta su
   número** (si no, el evento se queda sin remitente).
2. Leer `contacts[0]?.profile?.name`, que reventaba con *«Cannot read properties of undefined
   (reading 'name')»* — está en el log de la instancia **PD Cloud** del 7 sep a las 19:30.

**Se portaron al fuente y viajan en el commit `31b4c4c5`.** Un `rsync --delete` los habría borrado
**sin que nadie se enterara**, y el fallo habría vuelto días después sin causa aparente.

🔴 **Por eso, antes de cada despliegue: contar los archivos de los dos lados y mirar QUÉ sobra.** Y
el `rsync` va con `--exclude 'main.js.bak-*'`, para no llevarse los respaldos que dejó quien parcheó
en caliente.

🔴 **Se parte del TAG, no de `develop`.** `develop` lleva meses de cambios encima y desplegarlo sería
un salto de versión encubierto. El PR #2680 se aplica **cherry-pickeando su commit**, no mezclando su
rama.

## Cómo se despliega

En la VPS2 (`ssh root@89.117.73.129`) el `docker-compose.yml` **monta el `dist` compilado encima de
la imagen oficial**, que es `evoapicloud/evolution-api:2.4.0-rc2`:

```
/opt/evolution-api/dist-parcheado  ->  /evolution/dist          (ro)   este repo
/opt/evolution-api/manager-dist    ->  /evolution/manager/dist  (ro)   evolution-manager-v2
```

```bash
npm ci
npx prisma generate --schema ./prisma/postgresql-schema.prisma   # lo necesita el tsc
npm run build                                                    # tsc --noEmit && tsup
rsync -a --delete --exclude 'main.js.bak-*' --exclude 'main.mjs.bak-*' dist/ root@89.117.73.129:/opt/evolution-api/dist-parcheado/
ssh root@89.117.73.129 'docker restart evolution-api'
```

🔴 **Node lee `main.js` al arrancar**: copiar el `dist` no hace nada hasta reiniciar el contenedor.

🆕 **El Manager, en cambio, NO pide reinicio** —son archivos estáticos que el backend sirve del disco
montado— y tiene **su propio procedimiento**, con la tabla de parches y sus trampas, en
`/home/lu/Proyectos/evolution-manager-v2/DESPLIEGUE-PD.md`. Ahí se despliega con
`npm run build` + `rsync -a --delete dist/ …:/opt/evolution-api/manager-dist/`, y **la comprobación es
qué bundle sirve producción**, no que el `rsync` termine bien.

**Antes de desplegar, se compara con lo que corre.** Debe salir el **mismo número de archivos** y el
`main.js` debe diferir **solo en los parches**:

```bash
ssh root@89.117.73.129 'find /opt/evolution-api/dist-parcheado -type f | wc -l'   # 803
find dist -type f | wc -l                                                        # 803
```

🆕 **3 oct 2026:** el compilado de `deploy/parches-pd` daba **807** en local; el de la rama del estado
de Meta da **815**: **8 archivos nuevos y esperados** (`salud-meta` y `salud-meta.service`, cada uno
en `.js`, `.mjs` y sus `.map`). 🔴 `tsup` compila **todo `src/`** al `dist`: un archivo nuevo en
`src/` siempre sube la cuenta, y por eso las pruebas viven en `pruebas-pd/` (y no en `test/`, que
está en el `.gitignore` de aguas arriba).

🔴 **OJO AL ACTUALIZAR EVOLUTION DE VERSIÓN:** ese montaje **tapa el backend de la imagen nueva y
nada avisa**. Al subir de versión hay que **rehacer esta rama sobre el tag nuevo** (o quitar la línea
del compose si los dos parches ya están fusionados aguas arriba).

## El bucle de reconexión, en corto

Al revincular por QR, WhatsApp responde un `515` («restart required») que Evolution atiende **a los
3 segundos**. Una conexión pedida desde fuera en ese hueco **corría contra** la reconexión
automática: quedaban dos sockets vivos, `createClient()` sobrescribía `this.client` con el segundo y
el primero se quedaba **huérfano** —reconectando, pero ya sin referencia que lo cerrara—.

- **`/instance/restart` NO lo arregla**: cierra `this.client`, que es justo el que sí tiene
  referencia. Medido en vivo: **17 conflictos por minuto antes y después** de llamarlo.
- **Los oyentes se quitan ANTES de cerrar.** Cerrar emite `connection.update`, y el manejador
  reconecta ante cualquier código fuera de `codesToNotReconnect`: cerrar sin dejarlo mudo abriría
  otro socket, o sea el arreglo provocando el fallo que arregla.
- **`this.client` no se anula.** Hay **136 accesos directos** `this.client.x` y solo **5** con `?.`,
  y quedan dos `await` por delante —uno de red—: anularlo abriría una ventana de cientos de
  milisegundos en la que cualquiera reventaría con un `TypeError`.

**El watchdog del servidor lo vigila desde el 3 sep 2026** (`evo-watch.sh`, v3): cuenta las
reconexiones por instancia en 5 minutos y con **10 o más** reinicia el contenedor. Antes solo miraba
el **estado**, que decía `open` durante todo el bucle.

## Los `@lid`: quien oculta su número en WhatsApp (5 sep 2026)

### Qué es un `@lid`

WhatsApp dejó que la gente **oculte su número** y use un **nombre de usuario**. Cuando alguien así
escribe, **no viene el teléfono**: viene un identificador acabado en `@lid` (*LinkedID*), y
`remoteJidAlt` **llega vacío**. En la base de Evolution se ve así:

```
147261627592774@lid  | (sin remoteJidAlt) | pushName: bierkagarcia8
59730227630087@lid   | (sin remoteJidAlt) | pushName: ERN
```

🔴 **`bierkagarcia8` es un nombre de usuario, no el nombre de una persona.** Ese es el rastro.

### El bug: una llamada que no existía

Para saber a qué contacto pertenece un `@lid`, Evolution le pregunta a Chatwoot por su API. La
pregunta estaba escrita con un método que el SDK no tiene, forzado con `as any` para que compilara:

```ts
const contact = (await (client as any).get('contacts/search', { params: {...} })) as any;
```

En ejecución reventaba **siempre**, y el `catch` lo dejaba en un `warn`:

```
WARN [ChatwootService] Error resolving LID from database: TypeError: t.get is not a function
WARN [ChatwootService] Could not resolve LID: 143486451986658@lid
```

⚠️ **Nunca funcionó, y por eso nadie lo notó**: hasta que WhatsApp no sacó los nombres de usuario,
esa función no se llamaba. **El bug es viejo; los `@lid` son nuevos.**

**El arreglo son los métodos del SDK**, que el propio archivo ya usaba 60 líneas más abajo:
`client.contacts.search({ accountId, q, sort })` y `client.contacts.filter({ accountId, payload })`.

Medido en la VPS2 el día del arreglo, en 12 horas: **184 fallos de resolución**, 16 identificadores
distintos, y **172 contactos creados con el identificador metido en el campo del teléfono**
(Dentística 150 · Zenithe 17 · Dento Estetic 3 · Proyección 2). ⚠️ **Esos 172 no se tocan**
(decisión de Luis) y **no crecen desde el 28 de julio**: WhatsApp empezó a mandar `remoteJidAlt` y el
código lo resuelve por ahí sin llegar al camino roto.

### Y el usuario, guardado en la ficha

Petición de Luis, y sale de entender el caso: el `+105828497510423` **no sirve para nada** —un
`wa.me/…` con él no abre ninguna conversación y cuelga el WhatsApp Web— pero **por nombre de usuario
sí se le puede escribir**.

El teléfono **no se toca** (cambiarlo rompería la búsqueda por `phone_number`, de la que depende
medio flujo), y se guardan al lado dos atributos que Chatwoot enseña en la ficha:

| Atributo | Ejemplo |
|---|---|
| `whatsapp_usuario` | `bierkagarcia8` |
| `whatsapp_lid` | `105828497510423@lid` |

🔴 **Se rellenan al CREAR el contacto y también al ACTUALIZAR uno existente.** Sin lo segundo, los
`@lid` que ya estaban se quedarían para siempre sin el dato. Los dos atributos están dados de alta
como `CustomAttributeDefinition` (`contact_attribute`) en las cinco cuentas.

### 🔴 Tres trampas al comprobar esto

- **El log de Evolution NO va en la hora de la VPS.** El contenedor corre en **UTC−3** y el servidor
  en **Europe/Berlin**: tres horas. Comparar la hora de un error con la del `docker inspect` sin
  convertir hizo **dar por roto un parche que funcionaba**. Se mira con
  `docker exec evolution-api date`.
- **Un `grep -c` de una cadena que YA existía no prueba nada.** Al desplegar se buscó
  `contacts.search` y salió 1 — pero esa llamada ya estaba antes. Lo que hay que comprobar es que
  **el patrón viejo desapareció**: `grep -c "contacts/search" main.js` → **0**.
- **Los mensajes están en la base de Evolution aunque no lleguen a Chatwoot.** Se buscan en la tabla
  `"Message"` de `postgres-evolution` por `key->>'remoteJid'`. Así se encontró el mensaje que una
  gestora decía haber respondido y no aparecía en la conversación.

### Respaldos de estos dos despliegues

```
/opt/evolution-api/dist-parcheado.bak-20260905-prelid       antes del parche del @lid
/opt/evolution-api/dist-parcheado.bak-20260905-preusuario   antes del de los atributos
```

## 🔴 UN TIMEOUT DE RED BORRA LAS CREDENCIALES, Y ESO CUESTA UN QR POR CLIENTE (6 sep 2026)

**El 6 de septiembre de 2026, un corte de red de 40 segundos dejó sin WhatsApp a cinco instancias.**
No fue WhatsApp, ni los teléfonos, ni ningún cliente: la VPS2 se quedó sin salida durante ~40 s
—quedó registrado como `i/o timeout` contra **los dos** resolvers DNS de Contabo—, los sockets
expiraron con **408** y **Evolution borró sus credenciales**. El relato completo, con la línea de
tiempo y cómo se distingue un corte de red de una avería de DNS, en la carpeta de la agencia:
`Documentacion/INCIDENCIA - Un corte de red de 40 segundos borró las credenciales de las cinco instancias de WhatsApp (6 sep 2026).md`.

### La cadena, línea por línea

```
socket sin respuesta
  → statusCode 408 (DisconnectReason.timedOut / connectionLost, node_modules/baileys)
  → whatsapp.baileys.service.ts:510   codesToNotReconnect = [loggedOut, forbidden, 402, 406, 408]
  → :536  shouldReconnect = false     → NO reintenta
  → :579  eventEmitter.emit('logout.instance', ...)
  → monitor.service.ts:415            listener de 'logout.instance'
  → monitor.service.ts:159 cleaningUp()
        :172  rmSync(INSTANCE_DIR/<id>)                    ← borra la carpeta
        :175  prismaRepository.session.deleteMany(...)     ← borra la credencial
  → sin credencial: la instancia solo se levanta con un QR nuevo
```

⚠️ **La línea del 408 es de UPSTREAM**, no nuestra: commit `72ca397c` (8 abr 2026, *«fix: logout
instance»*), puesta **para evitar bucles de reconexión** cuando el servidor devuelve un 408 en el
cierre. El efecto secundario es el que nos costó el día.

🔴 **Los códigos NO significan lo que parece**, y de esto depende qué se puede rescatar:

| Código | Qué es | ¿Se puede recuperar sin QR? |
|---|---|---|
| **401** `loggedOut` | cierre de sesión real (desde el teléfono, o WhatsApp la invalidó) | **No.** Aunque se recupere el fichero, la sesión ya no vale |
| **403** `forbidden` | restricción o baneo del número | No |
| **408** `timedOut` | pérdida de conexión. **Nadie hizo nada** | **Sí**, y está probado |
| **515** `restartRequired` | normal justo después de escanear | se resuelve solo |

### Lo que ya está probado: se recupera SIN QR

**Postgres no borra al borrar, marca.** Cuatro de las cinco instancias volvieron a `open` **sin
escanear un solo código**, sacando la credencial del fichero de la tabla `Session`. El
procedimiento, los cuatro guiones y las cinco trampas están en la carpeta de la agencia:
`scripts/sitios/rescate-credenciales-evolution/LEEME.md`.

🔴 **Es una carrera contra `autovacuum`:** lo PRIMERO es congelar los ficheros de la tabla; después
se investiga. Y se mira en **dos sitios**, porque **el tamaño decide dónde sobrevive la credencial**:
las de 2-3 KB van comprimidas en su propia fila, y a partir de ~4 KB se guardan aparte, en el TOAST
—de «Zenithe Clinica Dental» **no quedaba fila ninguna** y se recuperó igual desde el bloque suelto.

### 🟢 Lo que se hizo el mismo día (todo desplegado y verificado)

| # | Qué | Dónde | Commit |
|---|---|---|---|
| 1 | **Respaldo horario** de las credenciales, un fichero por instancia | `scripts/sitios/respaldo-sesiones-evolution.sh` (agencia) → `/usr/local/bin/`, cron `20 * * * *` | — |
| 2 | **El 408 ya no borra**: 5 reintentos (3-6-12-24-48 s) y, si no vuelve, cierra **conservando** la credencial | este repo | `a21a4731` |
| 3 | **El watchdog repara solo** y deja de decir `OK` con instancias caídas | `scripts/sitios/evo-watch.sh` v4 (agencia) | — |
| 4 | **Endpoint + botón** para devolverlas a mano, sin esperar al watchdog | este repo y `evolution-manager-v2` | `a039a65c` y `0b52e96` |

**Las dos rutas nuevas** (globales, como `fetchInstances`):

```
GET  /instance/restorableSessions   ->  {"restorable":[…],"count":n}
POST /instance/restoreSessions      ->  body {"instanceNames":["Mundo Veneco"]} (vacío = todas)
```

🔴 **Tres cosas que hay que saber si se tocan:**

1. **El contenedor NO ve `/root/backups/`.** Lee la copia de
   `INSTANCE_DIR/.respaldos-pd`, que vive dentro del volumen de instancias — lo único
   alcanzable **sin tocar el compose**. La llena el respaldo horario, que hace espejo.
   El nombre **no es un uuid a propósito**: `cleaningUp()` borra `INSTANCE_DIR/<id>`, así que
   una carpeta que no parece un id nunca entra en esa criba.
2. **`instanceExistsGuard` corta con un 400 todo lo que no lleve `instanceName` en la ruta**, y
   estas dos hablan de todas las instancias a la vez. Sin añadirlas a su lista blanca, el
   controlador **no llega a ejecutarse** y la respuesta es
   `{"status":400,…"instanceName" not provided}` — que parece un fallo del cliente y es del guard.
3. **Solo se ofrece el 408.** Con un 401 la sesión está cerrada de verdad: restaurar el fichero
   no serviría, y ofrecerlo sería prometer algo que no se puede cumplir.

**El botón** está en el dashboard del Manager, **solo se pinta si hay algo que restaurar**, enseña
**cuáles son, cuándo cayeron y de cuándo es su respaldo**, y deja elegir. Global pero no a ciegas:
las caídas llegan de las dos formas —ese día cayeron tres de golpe, pero las dos de Zenithe habían
caído cada una por su lado.

### 🔧 Lo que sigue sin hacer

Que un timeout **no destruya** lo que no hace falta destruir:

- **Proponer el arreglo a upstream.** El `cleaningUp()` en un 408 le pasa a todo el mundo que use
  Evolution, no solo a nosotros.
- **Vigilancia desde fuera** de la VPS2: hoy nadie confirma un corte de red del proveedor salvo por
  sus consecuencias.
- ⚠️ **Al actualizar Evolution de versión hay que rehacer esta rama sobre el tag nuevo**, o el
  montaje del `dist` tapa el backend nuevo y **nada avisa**.

---

## 🔴 LAS URLs DE FOTO DE WHATSAPP CADUCAN, Y LA CADUCIDAD VA DENTRO DE LA URL (6 sep 2026)

**El síntoma:** el logo de una instancia deja de verse en el Manager, con un recuadro gris en su
sitio. *«Si recientemente sí se veía»*, y encima **solo le pasa a la Cloud API**: la Baileys del
mismo número enseña su logo tan tranquila.

**La causa, medida en el navegador:** la misma imagen se pedía por **tres direcciones distintas**, y
una devolvía **403**:

| URL | Caducidad | Resultado |
|---|---|---|
| `…&oe=6A9DC00C` | **ese mismo día a las 15:33 RD** | ❌ **403** ← la que usaba la tarjeta |
| `…&oe=6AAAEF0C` | 10 días después | ✅ 200 (la que Evolution tiene guardada) |
| `…&oe=6AA1B48C` | 3 días después | ✅ 200 (la que Meta devuelve ahora) |

🔴 **El parámetro `oe=` de esas URLs es su fecha de caducidad, en hexadecimal.** Se lee así:

```bash
printf '%d\n' 0x6A9DC00C | xargs -I{} date -d @{}
```

**Por qué solo la Cloud API:** es la única que **pregunta a Meta** por el perfil desde el navegador.
Las Baileys usan la foto que Evolution guardó al conectar. Y el navegador servía **de su caché** la
respuesta vieja de Meta, con una dirección ya muerta — por eso «hace un rato se veía»: dejó de verse
**a la hora exacta** en que caducó.

**Arreglado** en `evolution-manager-v2` (`bc6855b`): `cache: "no-store"` en las consultas a Meta —
cachear una respuesta cuyas URLs caducan es guardar una dirección que se va a morir sola — y, si una
foto falla, **se prueba la siguiente candidata** en vez de esconder la imagen. Antes el `onError`
ponía `display:none` y dejaba el hueco gris **teniendo al lado una foto buena**.

🔴 **La regla que sale de aquí:** cuando una URL trae su propia caducidad, **no se guarda en ninguna
caché** ni se trata como un dato estable; y **un `onError` que esconde algo es una decisión, no una
red de seguridad**: esconde el fallo y también la alternativa.

⚠️ **Y una cosa más, anotada aunque no se tocó:** para preguntarle el perfil a Meta, **el Manager
manda el token de la instancia desde el navegador del usuario**. Funciona, pero esa consulta la
haría mejor el servidor. 🆕 **3 oct 2026: la tarjeta ya no lo hace** —nombre, foto, número visible y
estado llegan del backend en `fetchInstances` (apartado «El estado real de una Cloud API según
Meta»)—. ⚠️ **Queda una:** el formulario de **crear** una instancia Cloud API
(`NewInstance.tsx`) sigue preguntándole a Graph desde el navegador con el token que se acaba de
escribir ahí mismo.

---

## Dónde está el resto de la documentación

En la carpeta de la agencia, `Documentacion/`:

- `INCIDENCIA - Evolution en bucle de reconexion tras revincular, inundando Chatwoot (3 sep 2026).md`
- `OPERACION - evo-watch, el watchdog de Evolution API.md`
- `PROCEDIMIENTO - Revincular una instancia de WhatsApp por QR en Evolution (credenciales huérfanas).md`
- `INCIDENCIA - Evolution API, saturación del pool y falso fallo de reinicio 2026-08-05.md`

Con copia en la VPS2, en `/root/documentacion/`. **Si se corrige una, se corrige la otra.**

## Los mensajes con botones y las plantillas, en Chatwoot (8 sep 2026)

**El síntoma, con las palabras de Luis:** *«Cuando se envían plantillas, ya sea desde donde sea que
se envíen, no se ve la conversación… es como si no se hubiese mandado una y si no se hubiese
respondido nada. Donde sí se ve realmente es directamente en el teléfono.»*

**Dos causas distintas, las dos en `chatwoot.service.ts`.**

### 1. La plantilla de Meta: `no body message found`

`getConversationMessage` saca el texto con `getTypeMessage`, un objeto donde cada clave es un tipo de
mensaje, y `getMessageContent` **coge la primera cuyo valor no sea `undefined`**. Si ninguna encaja,
devuelve `undefined` y el mensaje **se descarta con un WARN**.

Una plantilla llega como `templateMessage`, con el texto **dentro** de `interactiveMessageTemplate`:

```json
"templateMessage": {
  "interactiveMessageTemplate": {
    "header": { "title": "Guía de WhatsApp: Método Alana" },
    "body":   { "text": "Hola 👋, Soy Luis Durán de Proyección Digital…" },
    "footer": { "text": "proyecciondigital.org - República Dominicana" },
    "nativeFlowMessage": { "buttons": [ { "name": "cta_url", "buttonParamsJson": "{…}" } ] }
  },
  "templateId": "2289240268147389"
}
```

**Ningún campo de texto plano**, así que ninguna clave encajaba. Ahora se arma el texto —encabezado,
cuerpo, pie y las etiquetas de los botones— con `textoDeInteractivo()`, y hay red por si acaso: las
`hydratedTemplate` clásicas de Baileys y, en último caso, `▶️ plantilla <id>`, para que **al menos
conste que hubo una**.

### 2. Los botones: `Interactive Button Message not mapped`

El bloque `isInteractiveButtonMessage` recorre los botones y **solo sabe crear el mensaje si es un
PIX** (`name === 'payment_info'`). Todo lo demás caía en un `else` con un WARN, y al final del bloque
hay un `return`: **el mensaje no se creaba nunca**. Con tres botones, el aviso salía **tres veces**,
porque el bucle recorre botones, no mensajes.

Ahora, si no era un PIX, se crea **un solo mensaje** con el texto armado por `textoDeInteractivo()`.

🔴 **`interactiveMessage` (lo que manda `sendButtons`) y `interactiveMessageTemplate` (una plantilla)
tienen la misma forma**, por eso el armador es uno.

🔴 **La etiqueta de un botón no es texto**: vive dentro de `buttonParamsJson`, que es una **cadena
JSON** (`{"display_text":"✅ Confirmar","id":"opt_confirm"}`). Se parsea con `try/catch`.

### 3. La respuesta del usuario

Se añadieron a `getTypeMessage` los tres tipos con los que llega: `templateButtonReplyMessage`
(`selectedDisplayText`), `buttonsResponseMessage` (`selectedDisplayText` o `selectedButtonId`) y
`interactiveResponseMessage` (un `paramsJson`, otra cadena JSON). Y también `interactiveMessage` y
`buttonsMessage`, que son las salientes.

### Cómo se comprobó, en el destino

```bash
# 1. enviar de verdad
curl -X POST "http://localhost:8080/message/sendButtons/Proyeccion%20Digital" \
  -H "apikey: $AK" -H 'Content-Type: application/json' \
  -d '{"number":"…","title":"Respuesta rápida","description":"Elige una de las opciones:",
       "buttons":[{"type":"reply","displayText":"✅ Confirmar","id":"opt_confirm"}]}'

# 2. mirar la BANDEJA, no el código de salida
docker exec chatwoot-postgres-1 psql -U chatwoot -d chatwoot_production -tAc \
  "select i.name, m.message_type, left(m.content,90) from messages m
     join inboxes i on i.id=m.inbox_id
    where m.created_at > now() - interval '3 minutes' order by m.id desc limit 3"

# 3. y que el aviso ya no aparece
docker logs evolution-api --since 2m 2>&1 | grep -i -E "not mapped|no body message found"
```

🔴 **El envío devolvía `201` con su `wamid` ANTES y DESPUÉS del arreglo.** El código de salida no
distinguía nada: lo único que lo distingue es **la fila en la base de Chatwoot**.

### 3 bis. 🔴 El formato de WhatsApp NO es el de Chatwoot

**WhatsApp** escribe `*negrita*`, `_cursiva_` y `~tachado~`.
**Chatwoot** pinta con **markdown-it** (`MessageFormatter.js` del fork), donde `*x*` es **cursiva** y
la negrita es `**x**`. Sin traducir, el título de un mensaje con botones se veía **en cursiva** —o
con los asteriscos a la vista—, no como en el teléfono.

La traducción existía **escrita a mano dentro del flujo normal**:

```ts
.replace(/\*((?!\s)([^\n*]+?)(?<!\s))\*/g, '**$1**')   // *negrita*  -> **negrita**
.replace(/_((?!\s)([^\n_]+?)(?<!\s))_/g,   '*$1*')     // _cursiva_  -> *cursiva*
.replace(/~((?!\s)([^\n~]+?)(?<!\s))~/g,   '~~$1~~')   // ~tachado~  -> ~~tachado~~
```

Ahora es el método **`aMarkdownDeChatwoot`** y lo usan **los dos caminos**.

🔴 **Se escribe en formato de WhatsApp y se traduce al final; nunca al revés.** Generar `**x**`
directamente lo rompe: el primer regex volvería a envolverlo y saldría `***x***`.

🔴 **Va con `replace(/…/g)`, no con `replaceAll`.** El `lib` del proyecto es anterior a ES2021 y
sobre un `string` tipado el compilador lo rechaza (`TS2550`); en el flujo original colaba porque la
variable era `any`.

**Lo que se guarda ahora en Chatwoot, comprobado en la base:**

```
**Respuesta rápida**

Elige una de las opciones:

*Proyección Digital*

---
↩ **✅ Confirmar**
↩ **❌ Cancelar**
↩ **🤔 Tal vez**
```

La línea de guiones es un `<hr>` en markdown-it: es el separador que WhatsApp dibuja entre las
opciones. ⚠️ **`lheading` está deshabilitado en el formateador del fork**, así que unos guiones
debajo de una línea de texto **no** se convierten en un título.

### 4. 🔴 Sale por la Cloud API y se ve en la bandeja del QR

La plantilla se mandó por la instancia **PD Cloud** y apareció en la bandeja **«WS 1 - QR»**. Es la
**coexistencia**: el mensaje lo manda la Cloud API y **quien lo vuelve a ver y lo reporta a Chatwoot
es la instancia de Baileys**, que es la enganchada a esa otra bandeja. Hay que contarlo así al
equipo, o buscarán la plantilla donde no está.

**El relato completo está en la carpeta de la agencia:**
`Documentacion/INCIDENCIA - Los mensajes fuera de la ventana de 24 h no salen y Evolution los da por enviados (8 sep 2026).md`

---

## 🆕 De texto con markdown a TARJETA: los interactivos van con su estructura (8 sep 2026)

Todo lo de arriba hacía que un interactivo **llegara** a Chatwoot. Esto hace que **se vea como en el
teléfono**. Lo pidió Luis mirando las dos pantallas: *«hay ligeros detalles a pulir… el footer bien,
con su color particular, tal cual lo establece; los altos de línea bien»*, y sobre el menú:
*«en Chatwoot lo que está haciendo es desplegando las opciones completas de una vez, no debería»*.

### El problema de fondo: un mensaje que es una tarjeta no cabe en un párrafo

Un interactivo se convertía a **texto con markdown** y Chatwoot lo pintaba como cualquier párrafo.
De ahí salía todo lo que se veía mal, y ninguna de las tres cosas se arregla escribiendo mejor el
markdown, porque **el markdown no tiene forma de decir «esto es un pie» ni «esto es un botón»**:

| Se veía | Debería |
| :--- | :--- |
| Pie en **cursiva**, y si es un dominio, en azul y subrayado (markdown-it lo autoenlaza) | Gris pequeño, como en WhatsApp |
| Botones en líneas seguidas de un párrafo | Filas centradas, cada una con su línea de separación |
| El menú de lista **volcado entero**: `Section 1: / Line 1: / Title: / Description: / ID:`, en inglés | **Un botón «Ver opciones»** que despliega |
| El catálogo, una línea de texto y **las fotos perdidas** | Sus tarjetas con foto, precio y botón |

### La solución: la estructura viaja aparte, y el texto se queda

Evolution manda ahora, además del texto de siempre, **`content_attributes.pd_interactivo`** con la
forma del mensaje, y el fork de Chatwoot la pinta.

🔴 **El `content` NO se toca.** Es lo que se lee en el correo de notificación, en el buscador de
Chatwoot y en cualquier cliente que no sea nuestro fork. Si un día se cae el componente, el mensaje
sigue estando entero.

**Las cinco clases y de dónde sale cada una:**

| `clase` | Nace de | Qué lleva |
| :--- | :--- | :--- |
| `botones` | `interactiveMessage` / `interactiveMessageTemplate` | `encabezado`, `cuerpo`, `pie`, `botones[]` |
| `lista` | `listMessage` | `encabezado`, `cuerpo`, `pie`, `textoBoton`, `secciones[].filas[]` |
| `carrusel` | `interactiveMessage.carouselMessage` | `cuerpo`, `pie`, `tarjetas[]` con su `adjunto` |
| `pix` | un botón `payment_info` con `pix_static_code` | `comercio`, `clave`, `tipoClave` |
| `respuesta` | `listResponseMessage`, `templateButtonReplyMessage`, `buttonsResponseMessage` | `titulo`, `descripcion`, `id` |

**Un botón se normaliza a `{ clase, texto, url?, codigo?, telefono?, id? }`.** La clase sale del
`name` del botón, y cada una guarda su dato en una llave distinta: `cta_url` → `url`, `cta_copy` →
`copy_code`, `cta_call` → `phone_number`, `quick_reply` → solo su `id`.

### 🔴 El catálogo: las fotos van CIFRADAS y se suben aparte

Cada tarjeta lleva su imagen en `header.imageMessage`, y las de WhatsApp **no se descargan con su
URL**: van cifradas y hace falta la `mediaKey` del propio mensaje. `enviarCarrusel()` baja cada una
con `getBase64FromMediaMessage` —pasándole un mensaje armado a mano con **la `key` original**, que es
lo que permite descifrarla—, las sube como **varios `attachments[]` del mismo mensaje**, y anota en
cada tarjeta el índice de su adjunto. Chatwoot las casa **por posición**.

🔴 **Un carrusel NO pasa por el camino de medios**: `isMediaMessage` no lo reconoce, así que hay que
interceptarlo antes. Sin eso llegaba una línea de texto y las fotos se quedaban en WhatsApp.

🔴 **Si algo falla, se sigue por el camino de texto.** Un catálogo sin fotos se lee mal; un mensaje
que no llega no se lee en absoluto.

### 🔴 Tres trampas de esta tanda

1. **El cuerpo de la estructura va traducido a markdown de Chatwoot** (`aMarkdownDeChatwoot`), porque
   lo pinta el mismo renderizador: en WhatsApp `*x*` es negrita y en markdown-it es **cursiva**.
2. **En la bandeja NO se pintan las dos cosas.** El texto del mensaje ya trae encabezado, pie y
   botones; si además se pintara el `content`, saldría todo **dos veces**. El componente usa el
   `cuerpo` de la estructura y deja el texto de respaldo sin usar.
3. **El encabezado no siempre está en `header`.** Los botones que manda el propio Evolution lo llevan
   **en negrita dentro del cuerpo** (`*Respuesta rápida*\n\nElige una de las opciones:`). Se deja
   así: el cuerpo se pinta con su formato y se ve igual que en el teléfono.

### La otra mitad, en el fork de Chatwoot

`app/javascript/dashboard/components-next/message/bubbles/Text/` — `WhatsappInteractivo.vue` pinta,
y `TarjetaWhatsapp.vue` es la presentación común que comparte con la plantilla oficial, para que una
plantilla y unos botones **se vean exactamente igual**. Va con sus pruebas, y **fallan si se quita el
arreglo** (comprobado).

### 🔴 El PIX es de Brasil y NO se puede disfrazar (8 sep 2026)

Preguntó Luis: *«en LATAM no se usa PIX ni se conoce… ¿cómo lo personalizamos con algún otro método,
ejemplo Binance, o incluso un pago móvil Bs Venezuela? ¿Se le puede meter logo?»*. La respuesta corta
es **no**, y conviene que esté escrita para no volver a intentarlo:

- **`type: "pix"` no es un botón de texto: es una función nativa de WhatsApp Pay Brasil.** Se traduce
  a `payment_info` + `pix_static_code` (`whatsapp.baileys.service.ts`, `toJSONString`), y **la tarjeta
  la dibuja el cliente de WhatsApp**: el icono, el rótulo y el texto del botón no son nuestros.
- **El `keyType` solo acepta llaves brasileñas**: `cpf`, `cnpj`, `phone`, `email` y `random` (EVP).
  Una cédula venezolana o una dirección USDT no encajan en ninguna.
- 🔴 **Y al PIX NO se le puede poner logo.** El bloque del PIX en `buttonMessage()` hace `return`
  **antes** de la sección del encabezado, así que el `thumbnailUrl` no llega a aplicarse nunca.

**Lo que sí sirve en LATAM: `cta_copy` con imagen de cabecera.** Es genérico, el texto lo pone uno, y
sirve igual para Pago Móvil, una transferencia local, Zelle o Binance:

```json
{
  "title": "Pago Móvil · Banesco",
  "description": "Cédula V-12.345.678\nTeléfono 0414-1234567\nBanco 0134",
  "footer": "Envía el comprobante por aquí",
  "thumbnailUrl": "https://…/logo-banesco.png",
  "buttons": [
    { "type": "copy", "displayText": "📋 Copiar cédula", "copyCode": "V-12345678" },
    { "type": "url", "displayText": "🌐 Ver instrucciones", "url": "https://…" }
  ]
}
```

**Dos reglas que impone WhatsApp:** máximo **2 botones CTA** por mensaje, y **no se mezclan** los de
copiar/enlace con los de respuesta rápida (lo valida `buttonMessage()` y responde 400).

🔴 **Ese logo no llegaba a Chatwoot.** La imagen de un interactivo vive en `header.imageMessage`, y
`isMediaMessage` **solo mira las claves de primer nivel** del mensaje: para él, un interactivo con
logo no es un mensaje con medio. Se quedaba en el teléfono, igual que las fotos del catálogo. Ahora
`enviarBotonesConLogo()` la baja y la sube como adjunto, y el fork la pinta arriba de la tarjeta.

### 7.2 🔴 Lo que se probó con la tarjeta del PIX, y por qué se descartó (8 sep 2026)

Luis quería **esa misma tarjeta** con el logo de Binance: *«¿cómo coño hace para colocar el ícono?
Está escrito a código, ¿el ícono está estructurado en un SVG o es un PNG?»*. Se probó todo lo que
quedaba, y esto es lo que se midió **enviando mensajes reales**, no leyendo documentación:

| Se probó | Resultado |
| :--- | :--- |
| Cambiar el título y la clave (`name`, `key`) | 🟢 **Funciona.** Salió «Binance Pay» y el ID |
| `key_type: "ID"` para que el prefijo dijera `ID:` | 🔴 **No.** WhatsApp **traduce** el valor y, ante uno que no conoce, cae a **«Teléfono»**. Los únicos rótulos son EVP, Teléfono, E-mail, CPF y CNPJ |
| Mandar el pago **con encabezado de imagen** (nunca se había podido: el bloque salía antes) | 🟢 **Funciona.** El logo aparece **encima** de la tarjeta |
| Acompañarlo de un `cta_copy` propio, para tener un botón que diga lo que uno quiera | 🟢 Evolution ya lo permite (su prohibición era suya, no de WhatsApp) |
| Cambiar el **icono** o el rótulo **«Copiar clave Pix»** | 🔴 **Imposible.** No son campos: `NativeFlowButton` solo tiene `name` y `buttonParamsJson`, **las dos cadenas de texto**. El icono está en la app |

**Decisión de Luis:** *«esa plantilla de PIX no nos va a servir, mejor olvidarla, dejarla ahí de
ejemplo para saber que existe»*. Los cobros se hacen con **imagen + texto + botón de copiar**, que da
control total del texto a cambio de no tener icono dentro de la línea.

🔴 **Y de aquí salió un fallo de upstream:** `buttonMessage()` escribía `` `*${data.title}*` `` **sin
comprobar que hubiera título**, así que un mensaje sin `title` llegaba al teléfono con la palabra
**undefined** en negrita. Un mensaje sin título es legítimo —cuando el texto ya empieza por su propia
línea en negrita, un título encima sobra—. Corregido: si no hay ni título ni descripción, no se manda
`body`.

🔴 **Para descubrir si WhatsApp reconoce otros tipos de pago** (y con qué icono los dibuja) **no hay
lista**: los conoce el cliente, no el protocolo. Por eso un botón acepta ahora `paramsJson`, que se
manda **tal cual** como `buttonParamsJson`: es la forma de probar valores y ver qué pinta el teléfono.

### 7.3 La vía oficial existe, pero no nos toca (8 sep 2026)

Se investigó a fondo por qué la tarjeta del PIX existe y cómo se tendría una propia. Resultado:
**los pagos nativos de WhatsApp están habilitados en India, Brasil, México e Indonesia**, y dentro de
esos países **los operan proveedores de pago externos** —en India, Razorpay, PayU, BillDesk y
Zaakpay— integrados con Meta a través del programa **Solution Partner**. En Brasil hay una
**Payments API** propia con el mensaje `order_details`.

🔴 **No aplica a la agencia** (decisión de Luis): *«no somos un método de pago oficial, somos una
agencia de gestión de campañas publicitarias»*, y **RD y Venezuela no están** en esos cuatro países.

**Lo adoptado es imagen + texto + botones de copiar**, que es lo que hay en las dos pestañas de cobro.
❌ **Descartado dibujar la tarjeta entera como imagen.**

**El relato completo, con fuentes y con lo que queda disponible (WhatsApp Flows), está en la carpeta
de la agencia:** `Documentacion/INCIDENCIA - Los mensajes fuera de la ventana de 24 h no salen y
Evolution los da por enviados (8 sep 2026).md`, apartado 16.

## 🆕 El estado real de una Cloud API según Meta (3 oct 2026)

### El caso

«Zenithe 2 - Cloud Api» (phone_number_id `1219661531237557`, WABA `1241246318075956`) salía
**«Conectado»** en el Manager mientras el número llevaba desde el **30 sep a las 23:18 RD** «Fuera de
internet» en el Business Manager de Zenithe y la app «Cloud API - PD» había perdido el acceso: Graph
contestaba `GraphMethodException`, **code 100, subcode 33** («Object with ID … does not exist, cannot
be loaded due to missing permissions…») y los envíos, `Unsupported post request`. **Nadie se enteró en
dos días.** Causa probable: coexistencia sin actividad en la app del teléfono. Luis: *«tiene que
indicar realmente que esa instancia está desconectada, no aparecer conectado como sale
actualmente»*. Y después: que diga **a futuro qué tipo de desconexión fue** (intencional o sola).

La raíz: una instancia `WHATSAPP-BUSINESS` no tiene socket, y
`BusinessStartupService.stateConnection` es `{ state: 'open' }` **fijo** (línea 48 de
`whatsapp.business.service.ts`). Nada le preguntaba nunca a Meta.

### Qué hace ahora

- **`src/api/integrations/channel/meta/salud-meta.ts`** (sin estado, probado con Graph simulado):
  `GET {WA_BUSINESS.URL}/{VERSION}/{number}?fields=status,display_phone_number,verified_name,quality_rating,name_status,new_name_status`
  con el token de la instancia, y si contesta, la foto. Lectura: **190 → `TOKEN_INVALID`**;
  **100/33, 10 y 200-299 → `NO_ACCESS`**; red, timeout, 5xx y límites (1, 2, 4, 17, 32, 613…) →
  **«sin comprobar»** (nunca «desconectado»); otro error → no concluye nada. Del `status` de Meta,
  `CONNECTED`, `FLAGGED`, `RATE_LIMITED` y `UNKNOWN` cuentan como que funciona (los tres últimos con
  aviso ámbar); **cualquier otro, como caído**. Los textos en español salen de aquí (`motivoMeta`).
- **`salud-meta.service.ts`** guarda por instancia: `metaStatus`, `metaCheckedAt` (última respuesta
  concluyente), `metaError`, **`metaGraphError` (code, error_subcode, type, message, fbtrace_id)**,
  `displayPhone`, `verifiedName`, `qualityRating`, `nameStatus`, `newNameStatus`, la foto,
  **`metaFailingSince`** (el primer chequeo que lo vio caído en esta racha), **`metaLastOkAt`**, el
  último intento fallido y un **historial de 30 entradas** (cambios de estado con el código anterior
  y el nuevo, y avisos de cuenta). Un timeout conserva el último dato concluyente.
- **Cuándo:** a los 20 s de arrancar y cada **30 min** (`PD_SALUD_META_MINUTOS`; `0` lo apaga), en
  `POST /instance/refreshProfiles` (el «Actualizar» del Manager), al llegar un aviso de cuenta (como
  mucho uno cada 5 min por instancia) y a demanda con **`POST /instance/metaHealth`**
  (`{instanceNames?: [...]}`, clave global; añadida a `instanceExistsGuard`, la trampa de siempre).
- **`fetchInstances`** devuelve en cada Cloud API: `metaStatus`, `metaCheckedAt`, `metaError`,
  `metaGraphError`, `metaCodigo` («100/33», «190» o el `status`), `metaConnected`, `metaMotivo`,
  `metaFailingSince`, `metaLastOkAt`, `metaAttemptAt`, `metaAttemptError`, `displayPhone`,
  `metaVerifiedName`, `metaQualityRating`, `metaNameStatus`, `metaNewNameStatus`,
  `metaProfilePicUrl`, `metaHistorial` (las 10 últimas) y `metaUltimoAviso`. **Y si Meta dice que el
  número no funciona y lo guardado es `open`, `connectionStatus` sale `close` EN LA RESPUESTA**, con lo
  guardado en `connectionStatusGuardado`.

### 🔴 Las dos trampas, y por qué esto no las pisa

1. **Al arrancar, `monitor.service.ts` (línea 297) solo auto-conecta las instancias guardadas
   `open`/`connecting`.** Si el estado de Meta se escribiera en `Instance.connectionStatus`, una
   Cloud API caída no se cargaría tras un reinicio y **los webhooks de Meta se perderían el día que el
   número vuelva**. Por eso el servicio **no escribe en la base** (la prueba usa una base falsa que
   solo sabe leer: cualquier `update` revienta) y el `close` vive solo en la respuesta.
2. **`delInstanceTime` (línea 57) borra la instancia que no esté `open` EN MEMORIA** pasado
   `DEL_INSTANCE` (solo se programa al crearla). El chequeo **no toca `stateConnection`**, así que no
   puede disparar ningún borrado. `connectionState`, `connect`, `logout` y `delete` siguen viendo
   `open` como siempre.
3. (Tercera, del montaje) **No se añadió ninguna columna**: el contenedor regenera el cliente de
   Prisma con el esquema **de la imagen oficial** (`deploy_database.sh` → `db:generate`), no con el
   de este repo. Se guarda en **`INSTANCE_DIR/pd-salud-meta.json`** (el volumen de instancias; mismo
   sitio que `.respaldos-pd`), que sobrevive a `docker restart`.

### Qué cambia para quien lee `fetchInstances`

- **El Manager**: ver su `DESPLIEGUE-PD.md` (la tarjeta sale «Desconectado» con el motivo).
- **Panel Dental** (`backend/app/modules/agency_whatsapp/instances.py`): lee
  `connectionStatus` → `normalize_state` → `close` pasa a **`disconnected`**, guarda
  `last_disconnected_at` y lo enseña. **No desafilia**: eso solo pasa con el 404 «instance does not
  exist» de `connectionState` (`is_instance_not_found`), que no cambia. Su explicación de un envío
  fallido usa `connectionState`, que para una Cloud API sigue diciendo `open`.
- **evo-watch** lee el estado **de la base** por `psql`, no de `fetchInstances`: no le afecta.
- ⚠️ **Los flujos de n8n que lean `fetchInstances` no se pudieron revisar** (el MCP de n8n daba 502
  el 3 oct): si alguno mira `connectionStatus` de una Cloud API, ahora puede ver `close`.

### Los avisos de cuenta de Meta (webhooks sin número)

El caso real: el último webhook del número (30 sep 23:18:44 RD) fue un `sent/delivered` normal y
luego silencio. **Y si hubiera llegado un aviso de cuenta, se habría perdido:**
`MetaController.receiveWebhook` leía `entry.changes[0].value.metadata.phone_number_id`, y un
`account_update` no trae `metadata`: reventaba con *«Cannot read properties of undefined (reading
'phone_number_id')»*, que solo dejaba un `unhandledRejection` en el log (la prueba lo reproduce
quitando el arreglo). Ahora `apuntarAvisosDeCuenta` registra `account_update`, `account_alerts`,
`account_review_update`, `phone_number_quality_update`, `phone_number_name_update`,
`business_capability_update` y `security` en el historial de las instancias de ese WABA (`entry.id`
o `waba_info.waba_id`) o número (`entity_id`), con una línea en el log y el `value` entero. Lo que
trae número (mensajes y estados) **sigue igual**.

🔴 **El dato que contesta «¿sola o intencional?»** es `account_update` → **`PARTNER_REMOVED`** con
`disconnection_info.reason` (`PRIMARY_INACTIVITY` = teléfono principal sin actividad ~14 días,
`COMPANION_INACTIVITY`, `BUSINESS_DOWNGRADE`, `CHANGE_NUMBER`, `USER_RE_REGISTERED`,
`ACCOUNT_DISCONNECTED`) e `initiated_by` (`SYSTEM` o `USER`). Según la doc de Meta solo viene
**«cuando la empresa usaba a la vez la app de WhatsApp Business y la Cloud API»** (coexistencia).
Además `ACCOUNT_OFFBOARDED` / `ACCOUNT_RECONNECTED`. Fuente:
`developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update.md`
(descargada el 3 oct 2026).

🔴 **Para recibirlos hay que suscribir esos campos en la app** (App Dashboard → WhatsApp →
Configuración → campos del webhook; doc `…/webhooks/overview.md`). **Y `account_update`,
`account_review_update` y `account_alerts` NO admiten `override_callback_uri`**: Meta los manda
**siempre a la URL de callback de la APP** (doc `…/webhooks/override.md`). Si esa URL no es
`/webhook/meta` de Evolution, no llegan aquí aunque estén suscritos. ⏳ **No se ha comprobado qué
campos tiene suscritos la app ni su URL**: eso es mirar el panel de la app (o Graph), y en esta tanda
no se llamó a Meta.

⚠️ **`/webhook/meta` no verifica la firma de Meta (`X-Hub-Signature-256`)**: cualquiera puede mandar
un aviso falso, que quedaría en el historial. Por eso un aviso solo dispara un chequeo cada 5 min por
instancia, y **el estado que manda es siempre el que contesta Graph**, no el aviso.

### Las pruebas

```bash
npx tsx --test pruebas-pd/salud-meta.test.ts      # 19 pruebas, Graph y base simulados
```

Viven en `pruebas-pd/` porque `tsup` compila **todo `src/`** al `dist` y `test/` está en el
`.gitignore` de aguas arriba. Cada arreglo se comprobó **quitándolo**: sin la lectura de 100/33 falla
una; sin el `close` en la respuesta, dos; sin la guarda del webhook, la del controlador, con el error
literal de producción.

### Al desplegar, qué mirar

1. `find dist -type f | wc -l` → **815** (807 + 8 de `salud-meta*`), y lo mismo en el servidor tras
   el `rsync`.
2. Tras el reinicio, a los 20 s, en el log: `Meta: "Zenithe 2 - Cloud Api" pasa de (sin comprobar) a
   NO_ACCESS — …subcode 33` (si sigue caído) y una línea por cada Cloud API.
3. `ls -la /evolution/instances/pd-salud-meta.json` **dentro del contenedor**: existe y crece.
4. `curl … /instance/fetchInstances` con la clave global: Zenithe 2 con `connectionStatus: "close"`,
   `connectionStatusGuardado: "open"`, `metaCodigo: "100/33"`; las demás Cloud API con `metaStatus`.
5. **La base sigue diciendo `open`** para Zenithe 2 (`select name, "connectionStatus" from "Instance"`):
   si dijera `close`, algo escribió donde no debía.

## 🆕 Vincular por QR o por código: los cuatro fallos del 8 oct 2026

La crónica entera, intento por intento y con la conversación de la clienta, está en la agencia:
`Documentacion/REGISTRO - La vinculacion por QR del numero de Viki (Dento Estetic 2) en Evolution: la
noche entera, intento por intento (7 y 8 oct 2026).md`. Aquí va lo que se cambió y por qué.

### 1. 🔴 Un `logout` dejaba la instancia sin poder vincularse (`isDeleting`)

`logoutInstance()` pone `isDeleting = true` y `endSession = true` para que el cierre de ese socket no
reconecte. `createClient` reponía `endSession`, **y `isDeleting` no lo reponía nadie**. Con la marca
puesta, la siguiente vinculación llegaba hasta el final **en el teléfono**: emparejaba, WhatsApp
mandaba el `515` («restart required», que es **normal** y obliga a reconectar) y `connectionUpdate`
escribía *«Instance is being deleted/ended, skipping reconnection attempt»*. El teléfono contestaba
**«No se pudo vincular el dispositivo. Se produjo un error»** (con código) o **«No se pudo iniciar
sesión. Revisa la conexión a internet»** (con QR). Ninguna de las dos cosas era verdad.

Medido dos veces la misma noche, con la clienta haciéndolo bien: código `E9RS-FL77` (emparejado a las
04:19:37 UTC, `515` a las 04:19:38 con `isDeleting: true`) y un QR (escaneado a las 04:52:59, `515` a
las 04:53:00). Con la marca fuera, el mismo teléfono vinculó a la primera (05:05:23).

**El arreglo:** una línea en `createClient`, `this.isDeleting = false`, junto a `endSession`. Un
socket nuevo es una instancia viva otra vez.

🔴 **Lo dispara cualquier `DELETE /instance/logout`**: el botón «Desconectar» del Manager, o un
`logout` por API. Antes solo se quitaba con `docker restart evolution-api` o recreando la instancia,
que es por lo que Luis tenía la costumbre de borrarla y crearla de nuevo.

### 2. Pedir el código con un QR abierto no daba código

`connectToWhatsapp` del controlador, con el estado en `connecting`, hacía `return instance.qrCode`
sin mirar el `number`. El Manager recibía `pairingCode: null` y pintaba la rueda sin fin.

**El arreglo:** `decidirVinculacion()` (`vinculacion.ts`). Si hay una generación en curso
(`enVinculacion()`) y lo pedido es de **otro tipo** —código con un QR abierto, QR con un código en
curso, u otro número—, se cierra y se abre la pedida (`abrirVinculacion`). Si es del mismo tipo, se
devuelve lo que hay **sin tocar el socket** (el Manager sondea `connect` cada ~10 s con el diálogo
del QR abierto). Una instancia **ya vinculada** que reconecta también pasa por `connecting` y **no se
toca**: abrirle otro socket sería el bucle 440.

Y la respuesta ya no trae restos: antes de abrir se vacía `instance.qrcode`, y `esperarGeneracion`
espera hasta 10 s a que llegue lo pedido (antes eran 2 s fijos y lo que hubiera: así salió un código
de cinco minutos).

### 3. «Reiniciar» no cortaba la generación

`/instance/restart` cerraba el socket y volvía a llamar a `connectToWhatsapp` **sin número**: la
generación seguía, en modo QR. Ahora, en mitad de una generación, `detenerVinculacion()` retira el
socket, pone `endSession` y deja la instancia en `close`. Con una instancia vinculada, «Reiniciar»
hace lo de siempre.

### 4. 🔴 Las credenciales a medias de un código dan 401 (salió al probar los otros tres)

`requestPairingCode` de Baileys escribe **`creds.me` con el número** (`{ id: <número>@s.whatsapp.net,
name: '~' }`) y `creds.pairingCode`. Desde ahí, **cualquier socket nuevo** entra por
`generateLoginNode(creds.me.id)` en vez de por el registro, y WhatsApp contesta **401**. Por eso:

- pasar de código a QR cerraba la instancia (lo cazó la primera prueba en producción de este
  despliegue: T2c devolvió `{count: 2}` y `statusCode: 401`);
- y una instancia quedaba dando 401 tras un intento de código fallido, mientras el endpoint seguía
  devolviendo el código viejo.

**El arreglo:** `limpiarCredencialesAMedias()`, que `abrirVinculacion` llama siempre. Si hay
`creds.me` y **no** hay `creds.account` (que Baileys solo escribe en `configureSuccessfulPairing`),
retira el socket —para que no las vuelva a guardar— y las borra. 🔴 **Si las credenciales se leen de
la base y la instancia tiene `ownerJid`, no se tocan**: ahí sigue mandando el camino de siempre.

🔴 **`client.user` NO sirve para saber si hay sesión**: con un código en curso ya devuelve ese
`creds.me` provisional. `enVinculacion()` mira `creds.account`.

### Las pruebas

```bash
npx tsx --test pruebas-pd/vinculacion.test.ts      # 14 pruebas; no toca WhatsApp ni la base
```

La de `createClient repone isDeleting` **falla si se quita la línea** (comprobado mutando el fuente).

### Cómo se comprobó en producción (8 oct 2026, 02:24 RD), con una instancia desechable

Con `zz-prueba-vinculacion` y el número ficticio `18095550100`, por la API local:

| Paso | Resultado |
|---|---|
| `connect` (QR) | `pairingCode: null`, ciclo 1 |
| `connect?number=…` **con el QR abierto** | `pairingCode: HFST3XRR`, ciclo 2, en 1 s. Log: *«piden código con una generación de QR en curso; se cierra y se abre la pedida»* |
| el mismo `connect?number=…` otra vez | el mismo código, sin abrir otro socket |
| `connect` (vuelta a QR) | QR nuevo, ciclo 3. Log: *«Half-paired credentials found… clearing them»* |
| `connect?number=…` otra vez | código nuevo `5X1BW8T6`, ciclo 4 |
| `restart` en mitad de la generación | `status: close`; **55 s después sigue en `close` y 0 generaciones nuevas** |
| `connect` tras cortar un código | QR, ciclo 1 (credenciales a medias limpiadas) |
| `logout` en mitad de una generación y `connect` | QR, y en el log **`isDeleting: false`** |

La instancia de prueba se borró (0 filas). ⚠️ **Lo que NO se pudo probar sin un teléfono:** una
vinculación completa después de un `logout` (el `515` seguido de `open`). Lo que está medido es que
la marca vuelve a `false`, que era la única diferencia entre el intento que falló y el que vinculó.

### Al desplegar, qué mirar

1. `find dist -type f | wc -l` → **819** (815 + 4 de `vinculacion`), y **829** en el servidor (los 10
   respaldos `main.js.bak-*` y `main.mjs.bak-*`, que el `rsync` excluye).
2. `docker exec evolution-api grep -c "Half-paired credentials found" /evolution/dist/main.js` → 1.
3. Las instancias, **iguales antes y después** del reinicio (`select name, "connectionStatus"`).

### 5. «Reiniciar» sobre una instancia parada que sale «Conectando» (`8ae95056`, 8 oct 2026, 02:44 RD)

Luis: *«en caso de que una instancia haya quedado conectando, la reinicia para que quede, pues, no
en ese estado. No generando otros QR o códigos»*. La tarjeta del Manager pinta **la fila de la
base**, y esa puede quedarse en `connecting` con la instancia ya cerrada en memoria (pasó tras los
intentos fallidos de la noche del 8 oct). `/instance/restart` contestaba ahí un `BadRequest` («is not
connected») que el `catch` devolvía como `{error: true, message: "[object Object]"}` con un 200, y
la tarjeta seguía igual.

Ahora, con el estado en `close`, llama también a `detenerVinculacion()`: retira el socket que quede,
vacía el QR y pone la fila en `close`. **No toca las credenciales**, así que a una instancia
vinculada que esté caída no le hace perder nada (tampoco la reconecta: eso es «Generar QR»).

Lo que hace «Reiniciar» según el caso, desde este commit:

| La instancia está… | «Reiniciar» hace |
|---|---|
| conectada (`open`) | lo de siempre: cierra y reabre la conexión con la misma sesión, sin QR |
| generando QR o códigos (`connecting`, sin emparejar) | corta la generación y la deja en `close` |
| parada (`close`), salga como salga en la tarjeta | la deja limpia y con la fila en `close` |

**Comprobado en producción** con `zz-prueba-reiniciar`: fila forzada a `connecting` con la memoria en
`close` → `restart` → `{"status":"close"}` y la fila en `close`. Después siguió generando códigos con
normalidad, y tres peticiones seguidas del mismo código (lo que hace ahora el Manager cada 5 s)
devolvieron el mismo código **sin abrir ningún socket**. Md5 del `main.js` en el servidor:
`856322cd50ed8258bb29fdf200b58dce`. Las 11 instancias, igual antes y después del reinicio (el tercero
de la madrugada: 02:16, 02:22 y 02:44).

### 6. Qué se borra al eliminar una instancia, y el resto que quedaba en Redis (`e2d4a218`, 8 oct 2026, 03:35 RD)

Luis preguntó: *«en caso de que sea una instancia ya más grande, con contactos, mensajes, ¿cómo
procede el borrado ahí? ¿Lo hace correctamente?»*. Comprobado en producción tras borrar la «Luis
Personal» antigua (miles de mensajes):

| Dónde | Qué pasa al borrar | Medido |
|---|---|---|
| **Base de datos** (Postgres) | Se borra la fila de `Instance` y, **en cascada**, todo lo suyo: `Message`, `MessageUpdate`, `Chat`, `Contact`, `Label`, `Setting`, `Webhook`, `Chatwoot`, `Session`… Las 34 claves ajenas que apuntan a `Instance` son `ON DELETE CASCADE` (mirado en `pg_constraint`, no en el esquema) | **0 filas huérfanas** en las diez tablas revisadas |
| **Disco** | `rmSync` de `/evolution/instances/<id>` y de `store/chatwoot/<nombre>` | Ninguna carpeta sobrante. Las fotos, audios y documentos **no se guardan en disco** (S3 apagado; tabla `Media` con 0 filas): se piden a WhatsApp o a Meta al abrirlos |
| **WhatsApp** | El panel llama antes a `logout`: el dispositivo vinculado desaparece del teléfono | Visto por Luis el 8 oct |
| **Redis** | 🔴 **Aquí quedaba un resto.** Las claves de la sesión de Baileys viven en el hash `evolution:instance:<id>` y `cleaningUp` solo lo borraba con `CACHE_REDIS_SAVE_INSTANCES` encendido (aquí está apagado). Lo limpiaba `logout`, que **no hace nada si la instancia ya está en `close`** | **16 hashes huérfanos, 51 MB**, de instancias borradas estando caídas |

| **Copia de credenciales** | 🔴 **Y otro.** El watchdog guarda cada hora las credenciales de cada instancia en `/evolution/instances/.respaldos-pd/<id>.json`, para recuperar la sesión sin QR. Nadie borraba la copia al eliminar la instancia | **2 copias huérfanas** (la «Luis Personal» anterior y una «Dento Estetic 2 - QR» borrada esa noche) |

**El arreglo** (`dcac1fb4`, 03:50 RD; corrige a `e2d4a218`, que lo había puesto en `cleaningUp`):
`cleaningStoreData()` —que **solo corre al eliminar**— borra el hash de Redis y la copia de
credenciales. 🔴 **No va en `cleaningUp()`**, que también corre cuando una sesión se cierra: ahí la
instancia sigue existiendo y esas claves son las que permiten recuperarla sin QR con las
credenciales de respaldo (`restoreSessions`, que solo mira instancias que **existen** en `Instance`).

Probado en producción con dos instancias desechables: parada, con una clave puesta a mano en su hash
y una copia falsa → `delete` → **ni hash ni copia**. Y un `logout` sobre otra que sigue existiendo
**conserva** su copia.

🟢 **Los restos antiguos, limpiados el 8 oct a las 03:52 RD** (Luis: *«borrar ese caché de instancias
pasadas… Si ya no nos sirve y ya están borradas, ¿qué sentido tiene almacenarla? Revisa bien»*):
**16 hashes** de Redis y **2 copias** de credenciales, solo los de un id que **no está** en
`Instance` (comprobado uno a uno en el momento de borrar). Redis pasó de **75 claves y 46,05 MB a 59
claves y 11,35 MB**. Quedan 7 hashes y 7 copias, todos de instancias vivas; 0 huérfanos. Las 11
instancias, igual. Lo demás que hay en Redis (`groups`, `baileys`, las cachés de Chatwoot) lleva
caducidad y se va solo. En el disco no había carpetas de instancia de sobra.

⚠️ **Lo que NO se tocó, porque no son restos de instancias:** los 51 respaldos de código de `/root`
(792 MB entre `dist-parcheado-respaldo-*` y `manager-dist-respaldo-*`). Son la vuelta atrás de cada
despliegue; cuántos conservar es decisión aparte.

⚠️ **El borrado tarda en proporción al tamaño**: el backend contesta «Instance deleted» y borra
después, por el evento `remove.instance`. Por eso el Manager espera a que `fetchInstances` deje de
devolverla antes de decir «Eliminada» (`evolution-manager-v2`, `168fe73` y `6498e1e`).
