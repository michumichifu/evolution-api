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
rsync -a --delete dist/ root@89.117.73.129:/opt/evolution-api/dist-parcheado/
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
haría mejor el servidor.

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
