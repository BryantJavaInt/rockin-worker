# Rockin Worker — GitHub Sync

Mini-worker que sincroniza repositorios de GitHub, los persiste de forma idempotente en SQLite, y expone una Tool para consultarlos (vía CLI y vía servidor MCP).

## Setup

1. Clona el repositorio
2. Instala las dependencias:

npm install

3. Copia `.env.example` a `.env` y añade tu token de GitHub:

GITHUB_TOKEN=

El token necesita el scope `public_repo` (solo lectura de repos públicos).

## Cómo ejecutar

### Sync (trae y guarda los repos)
npx tsx src/sync.ts

### Tool - top items por estrellas (vía CLI)
npx tsx src/tool.ts getTopItems --limit 5

### Tool - búsqueda por nombre (vía CLI)
npx tsx src/tool.ts searchByName --query Fin

### Servidor MCP (expone ambas tools vía protocolo MCP)
npx tsx src/mcp-server.ts

### Tests
npm test

## Decisiones y trade-offs

- **SQLite en vez de JSON**: elegí SQLite porque la atomicidad de las transacciones viene prácticamente gratis, evitando problemas de corrupción si el proceso se interrumpe a mitad de escritura.
- **Clave natural para idempotencia**: uso el `id` de GitHub como PRIMARY KEY, ya que es único e inmutable para cada repositorio. Esto permite hacer upsert real: si el repo ya existe, se actualiza; si no, se inserta.
- **API elegida - GitHub**: elegí GitHub por su reproducibilidad y facilidad de autenticación con un PAT de solo lectura.
- **Reintentos con backoff y jitter**: distingo errores recuperables (429/5xx) de no recuperables (401/404). Solo reintento los recuperables, con backoff progresivo (1s, 2s, 3s) más una variación aleatoria (jitter) de hasta 500ms, para evitar que múltiples reintentos coincidan exactamente en el tiempo.
- **node:sqlite en vez de better-sqlite3**: better-sqlite3 requería compilar con Python, que no tenía configurado. node:sqlite viene integrado en Node.js (v22+) sin dependencias externas ni compilación.
- **Servidor MCP**: expuse dos tools (`getTopItems` y `searchByName`) como servidor MCP (stdio) usando el SDK oficial de Anthropic, permitiendo que un agente se conecte directamente y las use, replicando el patrón real de producción de Rockin.

## Governance

- **Mínimo privilegio**: el token usado tiene scope `public_repo` (solo lectura de repositorios públicos), sin permisos de escritura ni acceso a datos privados.
- **Sin PII**: los datos sincronizados (id, nombre, estrellas de repositorios) no contienen información personal identificable.
- **Auditoría**: el resumen de ejecución del sync (`fetched, inserted, updated, skipped, errors, apiCalls, durationMs`) sirve como registro auditable mínimo de cada ejecución.
- **Coste controlado**: existe un tope `maxPages` (actualmente 5) como válvula de seguridad frente a volúmenes inesperados de datos.

## Qué haría con más tiempo

- Implementar sync incremental usando un watermark (`updated_after`) para reducir el número de llamadas a la API en sincronizaciones sucesivas.
- Añadir más tests, incluyendo el comportamiento de la Tool con el caso vacío y del servidor MCP.

## Tiempo dedicado

Aproximadamente 9-10 horas, repartido en dos sesiones (sábado y domingo).