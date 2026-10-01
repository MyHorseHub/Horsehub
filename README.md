# HorseHub PowerSync Sync Lab 1.0

Isolierter Test von PowerSync mit Supabase für eine spätere HorseHub-Integration. Die App nutzt eine eigene SQLite-Datenbank im Browser und schreibt ausschließlich in `horsehub_legend_lab_feedings`.

## Voraussetzungen

1. Supabase-Tabelle `horsehub_legend_lab_feedings` ist angelegt.
2. In PowerSync eine Instanz anlegen und mit demselben Supabase-Postgres-Projekt verbinden.
3. Unter Client Auth **Use Supabase Auth** aktivieren.
4. Eine Sync-Streams/Sync-Rules-Konfiguration deployen, die `horsehub_legend_lab_feedings` für `request.user_id()` bereitstellt.
5. Die PowerSync-Instance-URL in der Test-App eintragen.

Die offizielle Supabase/PowerSync-Integration verwendet den Supabase-Access-Token zur Authentifizierung am PowerSync-Service; lokale Änderungen werden über `getNextCrudTransaction()` aus der SQLite-CRUD-Warteschlange gelesen und über den Supabase-Client hochgeladen.

## Beispiel Sync Streams (Edition 3)

```yaml
config:
  edition: 3

streams:
  horsehub_feedings:
    auto_subscribe: true
    query: |
      SELECT id, owner_id, horse_id, label, amount, unit, created_at, updated_at, deleted
      FROM horsehub_legend_lab_feedings
      WHERE owner_id = request.user_id()
```

## GitHub Pages

Der Workflow `.github/workflows/pages.yml` installiert die Abhängigkeiten, kopiert die PowerSync-Web-Worker-Assets und baut die App. `Vite` ist mit `base: './'` für Projektseiten konfiguriert.

## Test

Gerät A anmelden → PowerSync URL speichern → verbinden → `POWERSYNC TEST A` lokal anlegen → in Supabase prüfen.

Danach dieselbe App auf Gerät B öffnen und mit demselben Benutzer anmelden. Prüfen, ob der Datensatz in SQLite erscheint. Auf B ändern, anschließend auf A prüfen. Danach löschen.
