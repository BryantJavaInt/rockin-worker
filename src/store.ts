import { DatabaseSync } from 'node:sqlite';

// Definimos el TIPO de dato que vamos a guardar

export type Repo = {
  id: number;
  name: string;
  stars: number;
  syncedAt: string;
};

// Abrimos (o creamos si no existe) la base de datos
const db = new DatabaseSync('./data.db');

// Creamos la tabla si no existe todavía
db.exec(`
  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    stars INTEGER NOT NULL,
    syncedAt TEXT NOT NULL
  )
`);
// Función UPSERT: inserta si no existe, actualiza si ya existe
export function upsertRepo(repo: Repo): 'inserted' | 'updated' {
  const existing = db.prepare('SELECT id FROM repos WHERE id = ?').get(repo.id);

  if (existing) {
    // Ya existe -> UPDATE
    db.prepare(`
      UPDATE repos SET name = ?, stars = ?, syncedAt = ?
      WHERE id = ?
    `).run(repo.name, repo.stars, repo.syncedAt, repo.id);
    return 'updated';
  } else {
    // No existe -> INSERT
    db.prepare(`
      INSERT INTO repos (id, name, stars, syncedAt)
      VALUES (?, ?, ?, ?)
    `).run(repo.id, repo.name, repo.stars, repo.syncedAt);
    return 'inserted';
  }
}