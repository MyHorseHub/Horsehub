# HorseHub 1.25.4 – Browser-Test

## Lokal ausführen

Voraussetzungen: Python 3 und Playwright mit Chromium.

```bash
python -m pip install playwright
python -m playwright install chromium
python tests/horsehub_browser_test.py
```

Der Test simuliert Benachrichtigungen im Browser und prüft Termin-, Medikamenten-, Fütterungs- und Routinen-Erinnerungen einschließlich Duplikatschutz. Er prüft nicht die tatsächliche Zustellung durch Android, wenn die App geschlossen oder im Hintergrund ist. Das ist bewusst nicht Teil des Local-only-Modus.
