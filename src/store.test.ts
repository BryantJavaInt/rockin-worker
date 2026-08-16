import { describe, it, expect, beforeEach } from 'vitest';
import { upsertRepo } from './store.js';
import { DatabaseSync } from 'node:sqlite';

describe('upsertRepo', () => {
  // Antes de CADA test, borramos el repo de prueba si existe
  beforeEach(() => {
    const db = new DatabaseSync('./data.db');
    db.exec('DELETE FROM repos WHERE id = 999999');
  });

  it('inserta un repo nuevo la primera vez', () => {
    const resultado = upsertRepo({
      id: 999999,
      name: 'repo-de-prueba',
      stars: 10,
      syncedAt: new Date().toISOString(),
    });

    expect(resultado).toBe('inserted');
  });

  it('actualiza el mismo repo si ya existe (no lo duplica)', () => {
    // Insertamos primero
    upsertRepo({
      id: 999999,
      name: 'repo-de-prueba',
      stars: 10,
      syncedAt: new Date().toISOString(),
    });

    // Lo volvemos a guardar con datos distintos (simulando un cambio)
    const resultado = upsertRepo({
      id: 999999,
      name: 'repo-de-prueba',
      stars: 25, // cambió el número de estrellas
      syncedAt: new Date().toISOString(),
    });

    // Debe decir 'updated', no 'inserted'
    expect(resultado).toBe('updated');
  });
});