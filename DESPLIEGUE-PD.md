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
| `feat(chatwoot): guardar el usuario de WhatsApp de quien oculta su número` (`aa770124`, 5 sep 2026) | Quien esconde su número llega **sin teléfono**, solo con el `@lid`, y acababa guardado como `+105828497510423`, que no es ningún número. Ahora se guardan además `whatsapp_usuario` y `whatsapp_lid` en los atributos del contacto. Ver abajo. |

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

## Dónde está el resto de la documentación

En la carpeta de la agencia, `Documentacion/`:

- `INCIDENCIA - Evolution en bucle de reconexion tras revincular, inundando Chatwoot (3 sep 2026).md`
- `OPERACION - evo-watch, el watchdog de Evolution API.md`
- `PROCEDIMIENTO - Revincular una instancia de WhatsApp por QR en Evolution (credenciales huérfanas).md`
- `INCIDENCIA - Evolution API, saturación del pool y falso fallo de reinicio 2026-08-05.md`

Con copia en la VPS2, en `/root/documentacion/`. **Si se corrige una, se corrige la otra.**
