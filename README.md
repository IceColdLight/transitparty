# Transit Party

A racing prototype: **everyone starts at the same stop, everyone is trying to
reach the same other stop, and the only way to get there is public transport.**
The city is generated fresh every round, so nobody has memorised it.

It is a Wikirace where the links are tram lines. You get a network map and a
live view of every vehicle on it; what you do with that is the whole game.

Playable solo. Meant to be better with three.

---

## Running it

Two processes, both needed. A third only when you want other people to join.

```bash
npm install

npm run server     # terminal 1 — authoritative game server on :8081
npm run dev        # terminal 2 — Vite dev server on :5174
```

Then open <http://localhost:5174>. Open it a second time in another window to
race yourself and watch the sync work.

| Command | What it does |
| --- | --- |
| `npm run server` | Game simulation + WebSocket server. Restarts on file change. |
| `npm run dev` | Serves the client, and proxies the game socket at `/ws`. |
| `npm run typecheck` | `tsc --noEmit`. Run it before you trust a change. |
| `npm test` | Every suite, each in its own process. |
| `npm run shots` | Renders the world view and the network map to `shots/*.png`, with no browser. `npm run shots -- 4242` for a specific seed. |

> **Heads up:** `npm run server` uses `tsx watch`, so editing anything under
> `src/server` or `src/shared` restarts it — which starts a **new round in a
> new city**. If the map changes under you mid-playtest, that's why.

`PORT=8199 npm run server` runs a second server alongside the first, which is
how the integration suite drives a real socket.

### Playing with other people

The game socket rides the **same origin as the page** (Vite proxies `/ws`), so
you only ever share **one port**, and an HTTPS tunnel upgrades the socket to
`wss://` on its own — a browser refuses to open a plain `ws://` from a secure
page.

```bash
# one-time
mkdir -p .tools
curl -sSL -o .tools/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x .tools/cloudflared

# each session (server + dev must already be running)
.tools/cloudflared tunnel --url http://localhost:5174
```

It prints an `https://<random-words>.trycloudflare.com` URL. Send it to your
friends and they're in the same city. The URL is ephemeral and public — fine
for a playtest, don't leave it up.

Over a laggy link, players can add **`?delay=250`** to deepen their
interpolation buffer.

---

## How to play

| Key | |
| --- | --- |
| `WASD` | walk |
| `E` | board / get off |
| `TAB` | **hold** for the network map |
| `R` | unstick yourself |

You start on a platform. Somewhere across the city is a stop with a gold ring
around it. First one standing in that ring wins.

**Hold TAB and plan.** The map shows the whole network and every vehicle on it,
live, with a legend down the left telling you what each line is, how fast it
actually travels and how often it comes. It does not show you where you are
walking, so holding it costs you.

**The map lies about distance.** It is a diagram, not a map: the centre is
enlarged and the outskirts are squashed, exactly like every transit map you
have ever used. Two stops that look adjacent on the diagram can be a long walk
apart on the ground.

**You cannot walk across the river.** There are three bridges and only about
four lines cross at all. Getting to the far bank is a commitment, and picking
the wrong crossing is a mistake you cannot walk off.

**The doors matter.** A vehicle can only be boarded while it is standing at a
stop with its doors open — four to eight seconds depending on what it is, and
double that at a terminus. You cannot step off one in motion.

**You walk on streets, not through buildings.** The city is a grid of blocks
and you go round them, so the distance to a stop is rarely the distance to a
stop. Holding a diagonal walks you round a corner without touching the
keyboard again.

**The street view does not show you the network.** Down at street level you get
what you would actually get: roads, buildings, water, and a station sign with
the lines that call at it. Where those lines *go* is on the map.

---

## The four modes

Each one is the right answer somewhere, and each one is a trap somewhere else.

| | actually travels at | comes every | stops every | |
| --- | --- | --- | --- | --- |
| **S** train | ~79 km/h | ~2½ min | 950m | Crosses the whole city. Three or four stations in it. Worth waiting for over distance, absurd for two stops. |
| **M** metro | ~52 km/h | ~75s | 540m | The backbone — where it goes. |
| **T** tram | ~32 km/h | ~50s | 300m | Usually the thing that covers the last 600m the metro missed. |
| **B** bus | ~24 km/h | ~40s | 195m | Barely faster than running, but always nearby and always soon. |
| | on foot | ~9 km/h | — | Never the plan. Crossing the city takes about twelve minutes against a par of five and a half. |

Those speeds are what the lines really average end to end, dwells included —
not a cruise figure nobody travels at, and quoted against walking pace because
the city runs at three times real speed and "197 km/h" tells you nothing.
**The order is guaranteed:** every train line in every city is faster than
every metro line, every metro faster than every tram, every tram faster than
every bus. You never have to wonder.

**Only the train and the metro ignore the street grid** — one is elevated and
one is underground, and between stations they are drawn faded to say so. Buses
and trams are laid along the roads and turn corners, which makes them longer
than they look on the diagram.

**Door to door is a different question, and deliberately not ordered.** You
wait longest for a train, so over 800m the metro beats it and over 2500m it
does not. That crossover is the reason there are four modes instead
of a speed slider, and it is why the map legend prints the frequency next to
the speed.

---

## What a round looks like

The server generates a city, picks an origin and destination, and vets the
result before anybody sees it. A race is only used if it **crosses the river**,
needs **at least two changes**, takes **50 seconds to 2½ minutes** for a
perfect passenger, and is **at least twice as fast by transit as on foot**. Most
randomly generated pairs of stops fail at least one of those, so most of them
are thrown away.

A round ends when everybody has finished or three and a half minutes have
passed. Then there are eleven seconds of results and a brand new city.

The HUD shows `par` — what a planner reckons the trip takes assuming you turn
up at each stop not knowing when the next vehicle leaves. You have the live
board, so you should be beating it. In testing, a perfect passenger beats par
in 33 races out of 40.

---

## How it is built

TypeScript, no framework, canvas 2D. The interesting part is what is *not*
there.

**The city is never sent over the wire.** It is a pure function of one integer.
The server broadcasts a seed; every client rebuilds the identical network from
it, down to the timetable offsets. Switching to a whole new city costs four
bytes.

**Vehicles are not simulated.** There are no vehicle entities anywhere. Where
every tram in the city is at any moment is computed from the timetable and the
clock, so the server and every client independently agree on all hundred-odd of
them, exactly, for free. Riding one is just holding its id. This is also why
they draw perfectly smoothly at any framerate: the client is evaluating a
function, not replaying samples.

So the state packet is a handful of players and a seed, no matter how big the
city gets.

```
src/shared/     imported by the server, the client AND the tests
  constants.ts    every tuned number, once — including TEMPO
  rng.ts          seeded PRNG — the generator may not touch Math.random
  streets.ts      the grid: the only walkable surface, and the pedestrian graph
  river.ts        the water, the bridges, and what may cross them
  city.ts         the generator: streets → river → bridges → hub → the lines
  routing.ts      a route planner, used to vet generated cities
  vehicles.ts     the timetable as a pure function of (city, time)
  schematic.ts    the map's distortion, and why it has one
  movement.ts     walking, and what buildings and the river do to it
  types.ts
src/server/     authoritative: owns where players are, and nothing else
src/client/     main loop, the street view, the schematic overlay
tools/shots.ts  renders both views to PNG with no browser
tests/          seven suites, zero dependencies
```

`npm test` runs all seven. They check design properties, not code paths — that
every generated race needs two changes, that riding always beats walking, that
every bus leg runs along a street and no station is stranded inside a block,
that the map lies about distance but never tangles a line with itself, and that
you cannot walk across the water but can across a bridge.

`CLAUDE.md` is the working notes: what was tried, what was measured, and what
had to be pulled back out.
