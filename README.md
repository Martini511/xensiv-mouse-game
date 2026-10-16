# XENSIV™ Mouse – Sensor Hunt

3D-Third-Person-Spiel im Browser (**Three.js** + **Vite**) auf der echten
Platine der XENSIV™-Maus. Man ist auf Bauteilgröße geschrumpft, läuft über
Ober- und Unterseite der Platine und sucht die sechs Magnetsensoren.
Gesteuert wird mit Maus und Tastatur, im Notfall auch mit einem Controller.

Online spielen: <https://martini511.github.io/xensiv-mouse-game/>

## Spielziel

Alle sechs Magnetsensoren finden und markieren – jeden mit **genau der
Eingabe, die er in der echten Maus abtastet**. Hält man die Eingabe gedrückt
bzw. dreht am Mausrad, blinken die passenden Sensoren der aktuellen Seite
gelb auf.

| Bauteil | Seite       | Markieren mit  | Sensor                   |
| ------- | ----------- | -------------- | ------------------------ |
| `IC7`   | Oberseite   | Linksklick     | XENSIV™ TLI49901         |
| `IC8`   | Oberseite   | Rechtsklick    | XENSIV™ TLI49901         |
| `IC14`  | Oberseite   | Mausrad        | XENSIV™ TLE493D-W2B6     |
| `IC6`   | Oberseite   | Mausrad        | XENSIV™ TLV55624-1O      |
| `IC4`   | Unterseite  | Linksklick     | XENSIV™ TLI49012-E0001   |
| `IC13`  | Unterseite  | Rechtsklick    | XENSIV™ TLI49012-E0001   |

- Start ist auf der USB-C-Buchse vorne an der Platine.
- Auf die Unterseite geht es über den großen Chip **IC9** in der Mitte:
  hinaufspringen und **E** drücken.
- IC6 und IC14 liegen unter dem Mausrad – geht man nah heran, werden Rad und
  Halterung durchscheinend.
- Wer über die Platinenkante oder in einen Schlitz läuft, fällt herunter.
  Die Uhr läuft, die fünf besten Zeiten werden gespeichert.
- Nach dem Sieg (oder direkt vom Start mit **X**) gibt es einen
  Erkundungsmodus mit allen Infineon-Bauteilen der Platine.

### Interaktive Bauteile

- **S1 (XRES) / S2 (PROG)** auf der Unterseite federn ein, wenn man auf der
  Kappe steht – dabei leuchten **LED8** bzw. **LED5**.
- **Schiebeschalter S3**: auf das Gehäuse springen und gegen den Hebel laufen.
  Er bleibt in der neuen Stellung; auf „+5V“ leuchtet **LED6**.
- **Steckverbinder P1/P2** sind begehbar.
- **Mausrad**: dreht sich mit dem echten Mausrad mit und senkt sich beim
  Klick. Die Halterung ist begehbar (Platte → Türme → Achse). Der Magnet in
  der Nabe ist diametral polarisiert eingefärbt (Nord rot, Süd grün).

## Setup

Voraussetzung: Node.js 18+ und npm.

```bash
npm install
npm run dev
```

| Script            | Beschreibung                          |
| ----------------- | ------------------------------------- |
| `npm run dev`     | Dev-Server mit Hot Module Replacement |
| `npm run build`   | Produktions-Build nach `dist/`        |
| `npm run preview` | Build lokal testen                    |

> **Wichtig:** Die `index.html` lässt sich nicht per Doppelklick öffnen –
> ES-Module und Bare Imports (`three`) brauchen einen Webserver
> (`npm run dev` bzw. `npm run preview`).

## Deployment auf GitHub Pages

Jeder Push auf `main` startet
[.github/workflows/deploy.yml](.github/workflows/deploy.yml): Der Workflow
baut das Projekt und veröffentlicht `dist/` auf GitHub Pages. Dank
`base: "./"` in `vite.config.js` sind alle Asset-URLs relativ, der Build läuft
unter jeder URL.

Beim ersten Lauf schaltet der Workflow Pages selbst auf die Quelle
„GitHub Actions“ um. Scheitert das an den Repository-Rechten, einmalig unter
**Settings → Pages → Source** auf *GitHub Actions* stellen.

## Steuerung

| Maus / Tastatur        | Controller (Notfall)   | Aktion                                     |
| ---------------------- | ---------------------- | ------------------------------------------ |
| W A S D                | Linker Stick           | Laufen (kamerarelativ)                     |
| Maus                   | Rechter Stick          | Umsehen (Klick fängt die Maus, Esc gibt sie frei; sonst mit gedrückter linker Taste ziehen) |
| Leertaste              | F                      | Springen / Intro überspringen / abbrechen  |
| E                      | T                      | Seitenwechsel auf IC9 / bestätigen         |
| X                      | I                      | Erkundungsmodus                            |
| Links- / Rechtsklick   | L1 / R1                | Sensor markieren                           |
| Mausrad drehen         | L2 / R2 (analog)       | Sensor markieren, Rad drehen               |
| Mausrad-Klick          | L3 / R3                | Sensor markieren, Rad drücken              |
| Tab                    | D-Pad ↓                | Infobildschirm                             |
| ↑ / ↓                  | D-Pad ↑ / ↓            | Reiter im Infobildschirm                   |
| ← + → / Rücktaste      | D-Pad ← + →            | Zurück zum Intro (mit Rückfrage)           |

Maus/Tastatur und Controller laufen parallel, ohne Umschalten. Sobald der
Controller benutzt wird, erscheint unten rechts eine Kurzübersicht, und die
Hinweise nennen die Controller-Taste. Browser geben einen Controller erst
frei, nachdem einmal eine Taste daran gedrückt wurde.

## Projektaufbau

| Pfad                          | Inhalt                                              |
| ----------------------------- | --------------------------------------------------- |
| `src/core/level-config.js`    | Alle Spielwerte in CAD-Koordinaten (mm): Sensoren, Spawn, Taster, Schalter, LEDs, Mausrad, Tastenbelegung |
| `src/core/mission-texts.js`   | Spieltexte und Bauteil-Infos (Englisch)             |
| `src/core/Game.js`            | Spielablauf, Physik, Interaktionen                  |
| `src/core/Board.js`           | Platine laden, Kollision und Höhenraster ableiten   |
| `src/input/`                  | Maus/Tastatur und Notfall-Controller                |
| `src/assets/`                 | Platine mit Mausrad (`XENSIV_Mouse_with_wheel.glb`), Spielfigur, Logo |

Schwesterprojekt: das *Controller Game* auf der Platine des XENSIV™ Game
Controllers.