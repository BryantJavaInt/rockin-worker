# AI_USAGE.md

## Qué delegué a la IA y qué decidí/escribí yo

La IA generó el código base de cada archivo (`sync.ts`, `store.ts`, `tool.ts`, `mcp-server.ts`), pero yo revisé y entendí cada fracción del código explicada paso a paso. Por ejemplo, entendí por qué usamos PRIMARY KEY en la tabla: es una clave única que identifica cada repositorio, y permite que al hacer upsert, si el registro ya existe se actualice en vez de duplicarse. También entendí cómo funciona el símbolo `%` en las búsquedas SQL de `searchByName`, y por qué usamos `beforeEach` en los tests para que cada test empiece desde un estado limpio, sin depender del orden de ejecución.

## Dónde se equivocó la IA y cómo lo detecté y corregí

Tuvimos varios problemas técnicos durante el desarrollo:

1. **ts-node no funcionaba**: mi versión de Node.js (24.19.0) era demasiado reciente y `ts-node` daba un error de configuración. La solución fue cambiar de herramienta a `tsx`, una alternativa más moderna compatible con versiones recientes de Node.

2. **better-sqlite3 no se podía instalar**: este paquete necesitaba compilar código con Python, y no tenía Python bien configurado en mi ordenador. En vez de perder tiempo configurándolo, cambiamos a `node:sqlite`, el módulo de SQLite integrado directamente en Node.js, que no necesita ningún paquete externo ni compilación.

3. **El primer test fallaba**: al ejecutar los tests, el primer test esperaba `'inserted'` pero recibía `'updated'`, porque el registro de prueba ya existía de una ejecución manual anterior. Detecté el problema leyendo el mensaje de error de vitest, y lo corregimos añadiendo un `beforeEach` que limpia el registro de prueba antes de cada test, para que no dependan del estado dejado por ejecuciones previas.

4. **Top-level await no soportado**: al crear el servidor MCP, el código inicial usaba `await` directamente al final del archivo, lo cual no es compatible con la configuración `commonjs` del proyecto. Lo corregimos envolviendo esa parte en una función `async main()`.

## Qué NO le confiaría a la IA en este código

No le confiaría a la IA el manejo de datos reales de producción o de clientes sin que yo revise antes cada cambio — en un entorno real, cualquier código que toque información de la empresa necesita supervisión humana directa. Tampoco le confiaría la generación de tokens o claves de acceso reales: son credenciales protegidas del usuario y deben gestionarse manualmente, nunca generadas ni expuestas por una IA.

## Un prompt del que estoy orgulloso

Cuando `better-sqlite3` falló por no tener Python configurado, mi pregunta clave fue pedir una alternativa que no necesitara instalar ni configurar Python, dado que no tenía tiempo para hacerlo bien en ese momento. Esa pregunta llevó a la solución de usar `node:sqlite`, el módulo nativo de Node.js, que resolvió el problema sin dependencias externas.