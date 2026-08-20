# Transit Party — working notes

A racing prototype. Read `README.md` for what the game *is* and how to run it.
This file is what I wish I had known before touching the code.

---

## The one design rule

> **A race is worth running when the fastest route is not the obvious one, and
> finding it takes reading something the other players are also looking at.**

Everything follows from that. The game has one verb — get on, get off — and
almost no execution skill. All the difficulty has to live in the decision, and
a decision only exists if the alternatives are close enough to be tempting and
different enough to matter.

Which means the enemy is not difficulty, it is **indifference**: a city where
every plausible-looking route is within a few seconds of the best one. That is
the failure this prototype kept producing, it never throws, and it is invisible
unless you measure it. `tests/city.test.ts` and `tests/race.test.ts` exist
because of it.

Corollaries, all of which were violated and cost real rework:

- **A network with no chokepoint is not a map, it is a mesh.** Eighteen lines
  across a compact city, all crossing each other, plus a 260m walking transfer,
  and you get a small-world graph: everything is one change from everything.
  Measured over 25 cities and 100 candidate races, the optimal route needed two
  changes exactly **once**. Nothing was broken; there was simply nothing to
  plan. The river fixed it — see below.
- **Ask for the property you want, not a proxy for it.** Three separate
  attempts to force longer routes by constraining WHERE the endpoints could be
  (destination off the crossing lines, then both ends off them) moved the
  average from 1.07 changes to 1.13 to 1.67, and the last one threw away 25
  cities in 60. Setting `RACE.minTransfers = 2` and letting the generator find
  any pair with that property gave 2.4 changes with a 100% hit rate on the
  first attempt. The generator is better at searching than I am at predicting.
- **A number set by feel will quietly break a system three files away.** Walk
  speed was 3.6 m/s because the city "felt like treacle" slower. That is 13
  km/h. Waiting for a vehicle is a fixed cost paid once per leg, so a
  two-change journey pays three waits — and against a 13 km/h walk that made
  *riding the slow option*. 161 of 496 candidate races were rejected for it and
  not one survived. The fix was 2.4 m/s, and the treacle problem turned out to
  have its own answer: you spawn on the origin platform, so a round opens with
  a boarding decision instead of a walk.
- **Generate, then vet, then throw away.** Cities cost 5ms. Most randomly
  chosen pairs of stops are a bad race. The generator builds a city, samples
  400 candidate pairs, scores the ones that qualify and keeps the best — and if
  none qualify it throws the whole city away and builds another. It currently
  needs 1.05 attempts on average, which is the number to watch: if it climbs,
  something upstream has stopped producing races rather than started producing
  bad ones.

---

## The river is load-bearing

It looks like scenery. It is the reason the game has route planning in it.

You cannot walk across it except at one of three bridges, and only about four
lines cross it at all. So getting to the far bank means committing to one of a
handful of crossings, and choosing wrong is a mistake you cannot walk off.
Every generated race crosses it — that is a hard criterion, not a preference,
because a same-bank race has no decision at the top of it.

Two details that are easy to undo by accident:

- **`onBank()`'s clearance is 70m, and it used to be 130m.** At 130 no stop in
  any city was ever near the water, so the river only ever acted on the
  network's *shape* and never on a *walk*. The moment it was costing is
  standing on a quay looking at a platform seventy metres away on the wrong
  side. `tests/river.test.ts` checks that a near-neighbour is stranded in at
  least a quarter of cities.
- **Crossing lines are built as two corridors meeting at a bridge**, with the
  bridge forced to be a station (`via`). Bridge stations are where you are
  compelled to change banks, so they had better be somewhere you can get on and
  off.

---

## Two architectural facts everything rests on

**The city is never sent over the wire — it is rebuilt.** A city is a pure
function of one integer. The server broadcasts a seed; every client builds the
identical network from it, timetable offsets and all. A whole new city costs
four bytes. The rule this imposes: **nothing under `src/shared` may touch
`Date`, `Math.random`, or anything else outside its own `Rng`.** Break that and
two players are quietly in different cities, which will present as "the tram
isn't there" and take an hour to find.

**Vehicles are not simulated — they are evaluated.** There is no vehicle
entity anywhere in the codebase. Where every tram in the city is at a given
moment is a pure function of `(city, time)`. Three things fall out for free:

- the state packet is a handful of players and a seed. 304 bytes for one
  player, and it does not grow with the size of the city
- the client draws vehicles at the true present moment at whatever framerate it
  manages, with no interpolation and no jitter, because it is evaluating a
  function rather than replaying samples
- riding one is just holding its id — and a rider is drawn *at* their vehicle,
  so a full carriage moves as one solid object instead of a shivering cloud

If you ever find yourself wanting to store a vehicle's position, stop. The
thing you actually want is a different function of the clock.

A line runs out and back along the same stops, and both termini get a **double
dwell** because the end of one direction and the start of the other are
contiguous. That is the turnaround, it is why a terminus is the one place you
can reliably catch something you just missed, and it is why an integration test
that boarded at a terminus and timed the departure measured a bus that had
every right not to have moved yet.

---

## The map lies, on purpose

The schematic on TAB is a diagram, not a map: a radial power curve enlarges the
centre and squashes the outskirts, exactly like every real transit map since
Beck. The gap between the diagram you plan on and the city you walk in is a
mechanic — "two stops" can be four hundred metres.

What it may **not** get wrong is what a diagram is for: the order of stops
along a line, which lines meet where, and roughly which way is north. All three
are checks in `tests/schematic.test.ts`, along with the lie itself — a map that
quietly stopped distorting would collapse the game back into one view and
nothing would throw.

---

## The numbers, and what pins them

Everything tunable is in `src/shared/constants.ts`. These are the ones that are
consequences of other numbers rather than matters of taste:

| number | what actually sets it |
| --- | --- |
| `WALK.speed` 2.4 | the walk-versus-ride margin. Faster and riding loses; see above |
| `CITY.width/height` 3000×2100 | also the margin: waiting amortises over distance, and at 2400×1800 the planner could not find a single race where riding won by the required margin |
| `CITY.mergeRadius` 78 | the *entire* interchange system. Two stops closer than this are one station, so every transfer in the game is a consequence of geography. An earlier version wired interchanges explicitly and played like a diagram — every change at a tidy junction, none costing a walk |
| `RACE.minWalkRatio` 2.0 | the floor, not the target. Par charges an average half-headway per boarding; a player reading the live board beats it |
| `RACE.minTransfers` 2 | see "ask for the property" above |
| `line.headway` | *derived*, not the mode's target. The fleet is a whole number, so the real headway is `cycle / fleet`. Take the target literally and you get a remainder, which plays as one long unexplainable gap every cycle |
| `MODES.*.spacing` | what really separates the modes. It is the reason a bus is never far away and a train always is |

`tests/city.test.ts` holds the race criteria; `tests/race.test.ts` rides the
planned route against the real timetable and checks it can be followed at all.
That one is the closest thing to a playtest in the repo — if the numbers drift,
it is the suite that will notice first.

---

## Deliberate simplifications

Written down so they are choices rather than surprises:

- **Nothing collides except the river.** Buildings are scenery; you walk
  through them. Adding building collision means pathfinding, and the river
  already provides the one barrier the design needs.
- **A line has no branches.** Out and back along one list of stops. A branch is
  something you can board by mistake — a good mechanic and a bad first
  prototype, because "what is the next stop" stops having one answer.
- **Vehicles have no capacity and no delays.** Both are obvious things to add
  and both make the timetable stop being a pure function of the clock, which
  would cost the architecture above. If they go in, they have to go in as
  something still derivable from the seed.
- **Boarding is instant and free.** No fares, no tickets, no doors closing in
  your face — the dwell window is the whole timing game.
- **Own-walk prediction is a soft correction**, not rollback reconciliation.
  Walking is slow and deterministic, so client and server only ever differ by a
  packet's worth of lag.

---

## Where it goes next

In rough order of how much each would buy:

1. **Playtest with three people.** Everything above is measured, none of it is
   played. The specific unknown is whether *watching a rival's pip take the
   wrong bridge* is as good as it sounds.
2. **A reason to look at other players.** Right now they are information you
   can ignore. The nearest cheap idea: show which vehicle each rival is on, so
   a confident-looking rival is a hypothesis about the route.
3. **Disruption.** One line suspended mid-round, announced on the boards, would
   make the map worth re-reading halfway through. It has to stay a function of
   the seed and the clock.
4. **Round-to-round structure.** Best of five across five cities, scoring by
   margin rather than position.
5. **A line with a branch**, once "next stop" has a good answer in the HUD.
