"""HorseHub 1.25.0 browser smoke test.

Runs the real PWA HTML in Chromium with a local HTTP server. The Supabase CDN
script is replaced by a tiny in-browser stub so the test is deterministic and
never writes to the real HorseHub project.

Usage:
  python -m pip install playwright
  python -m playwright install chromium
  python tests/horsehub_browser_test.py

Optional:
  python tests/horsehub_browser_test.py --headed
"""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

SUPABASE_STUB = r"""
window.__hhStubCalls = {from: 0, rpc: 0, storage: 0};
window.supabase = {
  createClient: () => ({
    auth: {
      getSession: async () => ({data: {session: null}, error: null}),
      onAuthStateChange: () => ({data: {subscription: {unsubscribe() {}}}}),
      signOut: async () => ({error: null}),
    },
    from: () => {
      window.__hhStubCalls.from++;
      throw new Error('UNEXPECTED_SUPABASE_FROM_CALL_IN_LOCAL_ONLY_TEST');
    },
    rpc: async () => {
      window.__hhStubCalls.rpc++;
      throw new Error('UNEXPECTED_SUPABASE_RPC_CALL_IN_LOCAL_ONLY_TEST');
    },
    storage: {
      from: () => {
        window.__hhStubCalls.storage++;
        throw new Error('UNEXPECTED_SUPABASE_STORAGE_CALL_IN_LOCAL_ONLY_TEST');
      },
    },
  }),
};
"""


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def start_server(port: int) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )


def js(page, expr: str):
    return page.evaluate(expr)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true", help="Show Chromium window")
    args = parser.parse_args()

    failures: list[str] = []
    console_errors: list[str] = []
    page_errors: list[str] = []

    port = free_port()
    server = start_server(port)

    def attach_listeners(page):
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: page_errors.append(str(e)))

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=not args.headed,
            executable_path="/usr/bin/chromium",
            args=["--no-sandbox"],
        )
        context = browser.new_context(service_workers="block", viewport={"width": 390, "height": 844})
        page = context.new_page()
        attach_listeners(page)

        def check(name: str, condition: bool) -> None:
            if not condition:
                failures.append(name)
                raise AssertionError(name)
            print(f"✅ {name}")

        html = (ROOT / "index.html").read_text(encoding="utf-8")

        try:
            # Real browser mode: local HTTP origin + real localStorage.
            page.route("**/supabase-js@2*", lambda route: route.fulfill(
                status=200,
                content_type="application/javascript",
                body=SUPABASE_STUB,
            ))
            try:
                page.goto(f"http://127.0.0.1:{port}/index.html", wait_until="domcontentloaded", timeout=10000)
            except Exception as navigation_error:
                # The execution sandbox used by this environment blocks local-network navigation.
                # Fall back to an opaque-origin browser run with an in-memory Storage shim.
                if "ERR_BLOCKED_BY_ADMINISTRATOR" not in str(navigation_error):
                    raise
                page.close()
                page = context.new_page()
                attach_listeners(page)
                storage_shim = r"""
                <script>
                (() => {
                  const store = Object.create(null);
                  const api = {
                    get length() { return Object.keys(store).length; },
                    key(i) { return Object.keys(store)[i] ?? null; },
                    getItem(k) { const v = store[String(k)]; return v === undefined ? null : v; },
                    setItem(k,v) { store[String(k)] = String(v); },
                    removeItem(k) { delete store[String(k)]; },
                    clear() { for (const k of Object.keys(store)) delete store[k]; },
                  };
                  Object.defineProperty(window, 'localStorage', {value: api, configurable: true});
                  Object.defineProperty(window, 'sessionStorage', {value: api, configurable: true});
                })();
                </script>
                """
                html_inline = html.replace(
                    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>',
                    f"<script>{SUPABASE_STUB}</script>",
                )
                page.set_content(storage_shim + html_inline, wait_until="domcontentloaded")

            page.wait_for_timeout(200)
            page.evaluate("""
                localStorage.clear();
                showAuthenticated({}, {id: 'browser-test-user', email: 'browser-test@horsehub.local'});
                showById('home');
            """)
            expect(page.locator("#horsehubApp")).to_be_visible()

            # 1) Local-only mode and diagnostic cleanup.
            check("Local-only mode is enabled", bool(js(page, "HORSEHUB_LOCAL_ONLY_MODE === true")))
            check("Legacy sync-diagnostics card removed", page.locator("#syncDiagnosticsCard").count() == 0)
            check("Legacy write-trace card removed", page.locator("#localWriteTraceCard").count() == 0)
            for fn in [
                "runSyncDiagnostics", "runUploadDiagnostic", "runHorseSyncDeepDiagnostics",
                "startSyncRoundtripTest", "continueSyncRoundtripTest", "cleanupSyncRoundtripTest",
            ]:
                check(f"Diagnostic function {fn} removed", js(page, f"typeof {fn} === 'undefined'"))
            check("Home hero has no edit control", page.locator("#homeHero .hero-edit").count() == 0)
            page.locator("#settings").evaluate("el => el.classList.remove('hidden')")
            check("Hero editing remains in settings", page.get_by_text("Bildausschnitt bearbeiten", exact=False).count() >= 1)

            # 2) Create a horse, then edit the same horse instead of creating a duplicate.
            js(page, "showById('horses'); openHorseForm();")
            page.locator("#horseName").fill("Browser Test Pferd")
            page.locator("#horseBreed").fill("Andalusier")
            page.locator("#horseAge").fill("6")
            page.locator("#saveHorseButton").click()
            page.wait_for_timeout(150)
            horses = js(page, "JSON.parse(localStorage.getItem('horses') || '[]')")
            check("Horse saved locally", len(horses) == 1 and horses[0]["name"] == "Browser Test Pferd")
            horse_id = horses[0]["id"]

            page.get_by_role("button", name="Bearbeiten", exact=False).click()
            page.locator("#horseName").fill("Browser Test Pferd – geändert")
            page.locator("#saveHorseButton").click()
            page.wait_for_timeout(150)
            horses = js(page, "JSON.parse(localStorage.getItem('horses') || '[]')")
            check("Editing updates existing horse without duplicate", len(horses) == 1 and horses[0]["id"] == horse_id and horses[0]["name"] == "Browser Test Pferd – geändert")

            # 3) Notes: create, edit, delete.
            js(page, "showById('notes')")
            page.locator("#horse").select_option(label="Browser Test Pferd – geändert")
            page.locator("#note").fill("Erste Browser-Test-Notiz")
            page.get_by_role("button", name="Stallnotiz speichern", exact=True).click()
            notes = js(page, "JSON.parse(localStorage.getItem('notes') || '[]')")
            check("Note saved", len(notes) == 1 and notes[0]["text"] == "Erste Browser-Test-Notiz")

            answers = ["Bearbeitete Browser-Test-Notiz", "Browser Test Pferd – geändert"]
            def on_prompt(dialog):
                dialog.accept(answers.pop(0))
            page.on("dialog", on_prompt)
            page.get_by_role("button", name="Bearbeiten", exact=False).click()
            page.remove_listener("dialog", on_prompt)
            notes = js(page, "JSON.parse(localStorage.getItem('notes') || '[]')")
            check("Note edited", len(notes) == 1 and notes[0]["text"] == "Bearbeitete Browser-Test-Notiz")

            page.once("dialog", lambda d: d.accept())
            page.locator("#savedNotes").get_by_role("button", name="Löschen", exact=False).click()
            notes = js(page, "JSON.parse(localStorage.getItem('notes') || '[]')")
            check("Note deleted", len(notes) == 0)

            # 4) Team + plan: link plan to horse, share with team member, edit, delete.
            js(page, """
                localStorage.setItem('teamMembers', JSON.stringify([
                  {id:'tm-browser', name:'Browser Team', role:'Stallhilfe', email:'team@horsehub.local'}
                ]));
                renderTeam();
            """)
            js(page, "showById('team'); renderTeam();")
            page.locator("#teamList").get_by_text("Browser Team", exact=False).click()
            expect(page.locator("#teamManageCard")).to_be_visible()
            check("Team member opens management card", page.locator("#teamManageCard").is_visible())

            js(page, "showById('plans'); newPlan();")
            page.locator("#planName").fill("Browser Test Futterplan")
            page.locator("#planHorse").select_option(horse_id)
            page.locator("#planShareChoices input[type='checkbox'][value='tm-browser']").check()
            page.get_by_role("button", name="Plan speichern", exact=False).click()
            plans = js(page, "JSON.parse(localStorage.getItem('plans') || '[]')")
            check("Plan saved with horse and team share", len(plans) == 1 and plans[0]["horseId"] == horse_id and "tm-browser" in plans[0]["sharedWith"])

            page.locator("#plansList").get_by_role("button", name="Bearbeiten", exact=False).click()
            page.locator("#planName").fill("Browser Test Futterplan – geändert")
            page.get_by_role("button", name="Plan speichern", exact=False).click()
            plans = js(page, "JSON.parse(localStorage.getItem('plans') || '[]')")
            check("Plan edited", len(plans) == 1 and plans[0]["name"] == "Browser Test Futterplan – geändert")

            page.once("dialog", lambda d: d.accept())
            page.locator("#plansList").get_by_role("button", name="Löschen", exact=False).click()
            plans = js(page, "JSON.parse(localStorage.getItem('plans') || '[]')")
            check("Plan deleted", len(plans) == 0)

            # 5) Today list hides completed manual tasks.
            js(page, """
                const d = todayISO();
                localStorage.setItem('todayTasks', JSON.stringify([
                  {id:'open-task', title:'Offene Browser-Aufgabe', horseId:'', date:d, done:false, updated_at:new Date().toISOString()},
                  {id:'done-task', title:'Erledigte Browser-Aufgabe', horseId:'', date:d, done:true, updated_at:new Date().toISOString()}
                ]));
                localStorage.setItem('dailyDone', '{}');
                renderTodayTasks();
            """)
            visible_text = page.locator("#todayTodoList").inner_text()
            check("Completed task is hidden from Today", "Offene Browser-Aufgabe" in visible_text and "Erledigte Browser-Aufgabe" not in visible_text)
            page.locator("#todayTodoList input[type='checkbox']").first.evaluate("el => { el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true})); }")
            page.wait_for_timeout(50)
            check("All-done Today state appears", "Alles für heute erledigt" in page.locator("#todayTodoList").inner_text())

            # 6) No accidental cloud calls occurred during the local-only flow.
            cloud_calls = js(page, "({...__hhStubCalls})")
            check("No Supabase table/storage calls in local-only browser flow", cloud_calls["from"] == 0 and cloud_calls["storage"] == 0 and cloud_calls["rpc"] == 0)
            check("No unhandled page errors", not page_errors)
            check("No console errors", not console_errors)
            print("\nBrowser smoke test: ALL CHECKS PASSED")
            return 0
        except Exception as exc:
            print(f"\n❌ Browser smoke test failed: {exc}")
            if page_errors:
                print("Page errors:", page_errors)
            if console_errors:
                print("Console errors:", console_errors)
            if failures:
                print("Failed checks:")
                for item in failures:
                    print(" -", item)
            return 1
        finally:
            browser.close()
            server.terminate()
            try:
                server.wait(timeout=2)
            except subprocess.TimeoutExpired:
                server.kill()


if __name__ == "__main__":
    raise SystemExit(main())
