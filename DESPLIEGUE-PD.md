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

## Dónde está el resto de la documentación

En la carpeta de la agencia, `Documentacion/`:

- `INCIDENCIA - Evolution en bucle de reconexion tras revincular, inundando Chatwoot (3 sep 2026).md`
- `OPERACION - evo-watch, el watchdog de Evolution API.md`
- `PROCEDIMIENTO - Revincular una instancia de WhatsApp por QR en Evolution (credenciales huérfanas).md`
- `INCIDENCIA - Evolution API, saturación del pool y falso fallo de reinicio 2026-08-05.md`

Con copia en la VPS2, en `/root/documentacion/`. **Si se corrige una, se corrige la otra.**
