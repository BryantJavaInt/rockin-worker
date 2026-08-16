import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data.db');

// Tipo de la respuesta que devuelve la tool
type ToolResponse = {
  lastSyncAt: string;
  items: Array<{ id: number; name: string; stars: number }>;
};

export function getTopItems(args: { limit?: number }): ToolResponse {
  // Validamos el input: si no dan límite, usamos 5 por defecto
  const limit = args.limit && args.limit > 0 ? args.limit : 5;

  // Consultamos SOLO la base de datos (nunca llamamos a la API)
  const rows = db.prepare(`
    SELECT id, name, stars, syncedAt 
    FROM repos 
    ORDER BY stars DESC 
    LIMIT ?
  `).all(limit) as any[];

  // Caso vacío honesto: si no hay datos, lo decimos claramente
  if (rows.length === 0) {
    return {
      lastSyncAt: 'never',
      items: [],
    };
  }

  // Sacamos la fecha del último sync (el más reciente)
  const lastSyncAt = rows[0].syncedAt;

  return {
    lastSyncAt,
    items: rows.map(r => ({ id: r.id, name: r.name, stars: r.stars })),
  };
}

// Nueva tool: busca repos por nombre (búsqueda parcial)
export function searchByName(args: { query: string }): ToolResponse {
  const rows = db.prepare(`
    SELECT id, name, stars, syncedAt 
    FROM repos 
    WHERE name LIKE ? 
    ORDER BY stars DESC
  `).all(`%${args.query}%`) as any[];

  if (rows.length === 0) {
    return {
      lastSyncAt: 'never',
      items: [],
    };
  }

  return {
    lastSyncAt: rows[0].syncedAt,
    items: rows.map(r => ({ id: r.id, name: r.name, stars: r.stars })),
  };
}

// Permite ejecutar la tool desde la terminal:
// npx tsx src/tool.ts getTopItems --limit 5
// npx tsx src/tool.ts searchByName --query Fin
const args = process.argv.slice(2);
const command = args[0];

if (command === 'getTopItems') {
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex !== -1 ? parseInt(args[limitIndex + 1]) : undefined;
  
  const result = getTopItems({ limit });
  console.log(JSON.stringify(result, null, 2));
}

if (command === 'searchByName') {
  const queryIndex = args.indexOf('--query');
  const query = queryIndex !== -1 ? args[queryIndex + 1] : '';
  
  const result = searchByName({ query });
  console.log(JSON.stringify(result, null, 2));
}