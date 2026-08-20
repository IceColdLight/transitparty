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

## It is first person now, and the earlier argument against that was wrong

The prototype was top-down for three iterations and the case for keeping it
there was written down at the time: the decisions in this game are topological,
a schematic shows topology and a camera does not, and transit in first person
is mostly standing on a platform watching something approach — the part of the
loop with no verb in it.

Every one of those claims was true and the conclusion was still wrong, because
it assumed **boarding stays a button**. Once getting on and off is something
you physically do, the empty part of the loop is where the verbs are, and two
things fall out that the top-down version had to fake:

- **The information split is free.** In the street you cannot see the network,
  so the map has to be consulted and remembered rather than glanced at. The
  top-down view drew every line on the ground, which made the diagram on TAB
  decoration — you could plan a whole route without ever opening it.
- **Missing a connection becomes a thing that happens to you** rather than a
  number going up. Being carried two stops past your change because you were
  looking the wrong way is the same event as before and a completely different
  experience.

The lesson worth keeping is not "3D good". It is that an argument about a
design can be perfectly sound and still rest on an assumption nobody stated —
here, that the verb set was fixed.

---

## Neither half of the network may be enough

The complaint that forced this: *"taking the metro or the S-Bahn is easily the
fastest way to arrive; the buses are generally just padding on the map."*

It was true, and the measurements said so. A third of every city's stations sat
on the rail network, rail runs straight while road routes staircase around
blocks, and it stops rarely — so it won every comparison it was allowed into.
**Ignoring every bus and tram in the city cost 47%**, and it came within 15% of
the best route in a third of all races. "Find the metro" was a reliable
strategy, which made reading the map optional, which made the map pointless.

Two rules fix it, and both are what a real network looks like rather than a
handicap:

- **Races start and finish OFF the rail network.** The local lines are how you
  reach the trunk and how you leave it, which is the actual job of a bus.
- **A race is thrown away unless BOTH halves are genuinely insufficient
  alone** — rail-only must cost at least `RACE.minRailPenalty`, road-only at
  least `RACE.minRoadPenalty`.

The symmetry is not decoration. Penalising rail alone just moves the problem:
"always take the bus" is exactly as shallow a map as "always take the metro",
only slower. The road figure is the lower of the two on purpose, because buses
go everywhere so a road-only route nearly always EXISTS — demanding as much of
it throws away most of the good races.

Result: rail-only goes from x1.47 to about x1.5 with **no race within 15% of
the best route**, road-only likewise, and every generated race's best route now
uses both halves. Cities still generate on the first or second attempt.

`tests/city.test.ts` holds all of it, including the strongest form: the optimal
route mixes rail and road in every city.

---

## Traffic has to be separated, and only sideways works

The complaint: *"all modes of transport glitch into each other. Especially at
chokepoints and streets it's basically impossible to see what's going on and
pick the right bus."*

Vehicle position is a pure function of the timetable and nothing avoids
anything else, so every line calling at a stop parked in the same three metres
and every pair sharing a street drove through each other. Measured: **12.8% of
pairs both standing at a stop were interpenetrating.** Top-down that was
untidy. In first person it makes the one moment the game is about — choosing
which vehicle to walk to — impossible.

Three mechanisms, and the order they were tried in is the useful part:

- **Lanes.** Each line is displaced sideways, and the displacement flips with
  the direction of travel, so the city drives on one side. This is the one that
  matters: it separates all opposing traffic by construction.
- **Longitudinal bays were a dead end.** They only separate two vehicles if the
  offset exceeds the vehicle LENGTH, and a tram is 22m. Bays spaced far enough
  to work would put a vehicle a quarter of a block from its own stop.
- **Stands, per line per stop.** Lanes are expressed in each LINE's frame, so
  they separate lines that run parallel and do nothing whatever for lines
  meeting a stop from different directions — a tram coming north and a bus
  coming east sat on the junction two metres apart with their offsets pointing
  different ways. A stand is an index handed out per stop, so every line
  calling there gets a different one.

The lane assignment is a graph colouring, and the graph is what took two
attempts. Lines that share a STOP must differ — that is the moment the player
is choosing. Lines that merely share a street should differ, and if something
must give it gives there. Neighbours defined by shared stops alone missed most
of the conflicts: two bus routes can run the length of one street stopping at
different points and never share a node.

Result: **at-stop interpenetration 12.8% → 3.4%**, head-on effectively gone,
and no road vehicle ever leaves the road it is driving on.

The road had to get wider to hold it — 34m, three lanes each way plus a
platform clear of the outermost one. At 26m there was room for two lanes and
eight combinations for eighteen lines, which pigeonholes. Vehicles also went
back to near life-size widths; they had been half a metre over when landing on
a roof was how you boarded, and once doors became the way in that width bought
nothing and cost lane separation. Bus and tram headways went up by half, which
thins the traffic and makes catching one matter more.

**There are two platforms at every stop now, one each side**, because with
traffic keeping to one side the platform you want depends on which way you are
going — which is a question worth having to ask.

Three bugs came out of it and all three are the same shape — an offset that is
correct at a stop being applied where the vehicle is DRIVING:

- the stand was applied to a line's whole path, so a stand 27m up a
  north-south street and the next one 27m along an east-west street dragged
  the straight line between them across the middle of a block. **Buses drove
  through buildings** — and because a player standing off the street gets
  walked back onto it, anyone riding one had their velocity wiped every tick,
  which read as "jumping off a moving bus does nothing"
- stands are measured along the bisector of the two legs, which is the
  direction of the road only while the road is straight. At a corner it points
  diagonally across the junction and put a tram seven metres onto the
  pavement. Corner stops now forgo the separation rather than drive into a
  building to get it
- the "is this leg square to the grid" tolerance was half the street width, so
  widening the road quietly widened the tolerance with it

---

## Three levels, and stairs between them

The metro runs eight metres under the road and the train nine metres over it,
on proper track. Getting to either means finding a staircase, which gives the
player a second kind of wayfinding on top of reading the map: you surface
somewhere and have to work out where you are, and a change from the metro to a
bus is a climb rather than a step sideways.

The mechanism that makes two levels work at all is that **a point can have more
than one floor** — the road above and the platform below — and you stand on
whichever is nearest beneath your feet. It is the same rule that already
decided whether you were on the street or on a bus deck, extended to the
ground itself. A station is three rectangles:

  hall     the platform box, on the line's own axis, wide enough for its
           tracks plus somewhere to stand beside them
  shaft    the stairs, on the FOOTWAY and along the street
  passage  the corridor from the foot of the stairs in to the platform

Five things went wrong, and four of them are the same mistake in different
clothes — **a rule that is right for one level applied to another**:

- **Vehicles were drawn at y=0 regardless of level**, so every metro in the
  city drove down the middle of the road with the buses. The physics was
  already underground; only the picture was wrong.
- **A stop served by both a metro and a train got two staircases in the same
  place**, one down and one up. The floor under your feet then has two
  candidates, the game picks the higher, and walking into a subway entrance
  carries you up onto the viaduct. They now take opposite sides of the stop.
- **The stairwell was on the carriageway.** The entrance was put at the stop,
  which is the middle of the road, so a stairwell was a hole in the road with
  buses driving through it. It goes on the footway now, with a passage inward
  at platform level — and the passage does NOT punch through the road, which
  is what lets the stairs stand on the pavement.
- **Suppressing the street under an ascending flight** deleted the road beneath
  every elevated station. Only a stairwell going DOWN is a hole in the
  pavement; one going up is a thing standing on it.
- **The hall was a fixed width centred on the stop while the track ran off to
  one side in its lane**, so the rails came up through the platform. It is
  sized from the lines that actually call there.

Two more came out of playing it:

- **The station and its own track did not line up.** The hall was centred on
  the stop and its track bed drawn a fixed width about that centre, while the
  rails run at the LINE's lane offsets — so the train arrived in a grey box
  with its rails alongside, ignoring the track that had been laid. The bed is
  now measured from the lanes that actually call there, and a rail line's lane
  spread was cut, because a station has to be wide enough to hold both tracks
  and a platform and buildings have to be cleared out of it.
- **You could walk out over the rails on thin air**, which on an elevated
  station is nine metres of it. The hall is two floors now: the platform, and
  the track bed a deck's depth below it. You can drop down onto the track; the
  bodywork stops you being there when a train is.

And two that were only visible once you went looking for them:

- **A subway entrance was invisible.** The ground was one unbroken plane, so
  the road was paved straight over every descending stairwell: the stairs were
  there and you could walk down them and there was nothing at all to see from
  the street. The ground is a shape with a hole cut in it at each descending
  shaft now. Ascending flights get no hole — a staircase up to a viaduct
  stands ON the pavement and the pavement stays put.
- **Every station sign shimmered.** Signs are drawn back to back so they read
  from either side, and the twin was placed at exactly the same position —
  coplanar, so the depth test picked a different face per pixel per frame and
  the name and the line colours tore. Three centimetres along the normal fixes
  it.

And three more that all came from forgetting a railway has TWO running lines.
A vehicle sits at its stop plus its lane offset TIMES ITS DIRECTION, so the up
line is at +lane and the down line at -lane:

- **the rails were drawn once, at +lane**, so half the service ran on track and
  the other half floated in mid-air
- **the tunnel bore was built around one of them** and sat off to one side,
  with the other line running out through its wall
- **the corridor from the stairs ended over the track.** Two attempts failed
  before the obvious one worked: backing off a fixed distance along the
  corridor is no good when the stairs come in at an angle, because most of that
  distance is spent travelling ALONG the platform; solving for the
  across-component is no good when the stairs land on the station's centre
  line, because then no distance along that line clears anything. Name the
  destination — a point on a platform — and neither problem exists.

**Empty plots you could see and not walk on** came from the same era. Buildings
were being cleared off the metro's alignment, which was correct when rail ran
at street level and is nonsense now it is in a tunnel: a building above a
tunnel is exactly right. Only the viaduct and the elevated stations take up
ground. What is genuinely unbuildable — the railway strip, and the parks — is
fenced, because land you can see and cannot enter is indistinguishable from an
invisible wall unless something marks the edge.

A stairwell also needed WALLS. Without them you can walk off the side halfway
down and reappear on the road above, and anyone on the pavement can wander
into the hole sideways. You go in at the top and out at the bottom.

The route planner charges `STATION.access` for boarding anything not at street
level. A planner that thinks a platform eight metres down is free quotes
journeys nobody can make in the time — and it would quietly make rail look
better than it is, which is the thing the race criteria spend most of their
effort correcting for.

---

## Reconcile a passenger on the deck, not on the ground

Riding anything jittered badly, and the cause is worth remembering because it
looks like a rendering problem and is not.

The server reports where you were on ITS clock; the client predicts where you
are on its own; the two are never quite equal. In world space almost all of
that difference is the vehicle's own travel — three metres on a train at a
tenth of a second — so a world-space correction spends every frame dragging
the player backwards along the deck while the carry pushes them forwards.
That fight is the jitter, and it gets worse the faster the vehicle goes.

Comparing where you stand ON THE DECK removes the vehicle's motion from the
question entirely: both ends agree you are two metres from the door, whatever
the clock says. The same trick fixes other passengers, who were being
interpolated across the ground between two samples taken half a packet apart
and trailing wherever their vehicle had got to since.

The clock itself was the other half. Adding a fraction of the error straight
onto it made it wobble — the server's time advances in fixed steps and arrives
twice per three of them, so the error alternates — and since everything on
rails is a pure function of that clock, **a wobbling clock is a wobbling
city**. Steer the RATE instead and time stays monotone and smooth.

---

## Riding is a surface, not a state

There is no board key, no boarding rule and no `riding` transition anywhere. A
vehicle is a moving platform; `riding` is whatever your feet are on this tick.

That one decision pays for itself several times over. Missing your stop, being
carried past it, jumping off early, stepping onto the wrong line, being scooped
up by a bus while crossing a junction — all of them are the same mechanic
observed at different moments, rather than four rules that have to agree with
each other.

The fiddly part, and the source of most of the port's bugs, is that horizontal
velocity is stored **relative to whatever you are standing on**. On the street
that is the world; on a tram doing thirty metres a second it is the tram.
Converting between the two at the moment your feet leave or land is exactly
what makes stepping off throw you down the street instead of dropping you where
you stood — and getting the conversion wrong is silent in both directions.

Four rules sit on top of it:

- **A vehicle is a room with doors**, and on foot the doors are the only way
  through the walls. They are open exactly while it is standing at a stop. That
  one fact turns getting off at the right place into something you plan a few
  seconds ahead — be near a door, or spend the dwell walking to one and watch
  your stop go past.
- **The bodywork is solid from OUTSIDE too.** This is easy to forget and it
  makes the doors decoration when you do: a vehicle that is not an obstacle to
  a pedestrian lets you walk through the side of a parked tram, land in the
  middle of the floor plan, and get quietly lifted onto the deck. Every rule
  about doorways has to apply to getting in as well as getting out.
- **Road vehicles have waist-high sides; rail ones are sealed to the roof.**
  You may vault out of a tram at any speed; a metro keeps hold of you until the
  next station. The geometry says which without a word of UI, and it is also
  the only thing standing between a player and a jump into the middle of a
  solid block, which has no sensible answer.
- **You stay on what you are already standing on.** Vehicles do not avoid each
  other, so two lines calling at one stop routinely overlap; picking the
  highest deck instead handed the player from the bus they chose to whichever
  tram was sharing the road, and then the bus drove off without them.

---

## What the port broke, and how each was caught

Worth keeping as a list, because the pattern in it is the useful part: **almost
nothing here was caught by a test, and almost everything was obvious in a
picture or in one careful re-read.**

Found by looking at renders (`npm run shots`):

- every building pure black — an InstancedMesh carries its own `instanceColor`,
  and asking the shader for a per-vertex colour attribute the geometry does not
  have paints the lot black
- the destination beam started at ground level, so the first thing you saw of
  the city was the inside of its own signpost
- station signs sat at the centre of the platform, which is where a player
  waiting for a vehicle stands: a black rectangle across your view and a pole
  through your head
- riding looked like nothing. A vehicle was one solid box, and standing on its
  deck put the camera inside it where backface culling made the whole thing
  vanish — you travelled at thirty metres a second with no evidence you were
  on anything
- bridge decks stood 400mm proud of the road and the platform kerb 180mm, both
  of which pedestrians walked straight through, because walking is flat

Found by re-reading the code:

- **mid-air steering was scaled by walking speed as well as by the air
  acceleration**, giving about 72 m/s² of control — full authority, which
  quietly cancelled the momentum the jump exists for. No test caught it because
  every test jumped without holding a direction
- **falling onto a deck fell through it.** The search for a floor only looked
  at where the feet ENDED the tick, so on the one tick that mattered the deck
  was rejected for being above them. Hidden because every test boarded from the
  ground, where the step-up allowance covers it
- a `process.env` debug switch left in the scene would have thrown on load in a
  browser

The R key is gone too, and it is worth saying why rather than just deleting it.
It was labelled "unstick" and called `spawn()`, which teleported you to the
ORIGIN — an escape hatch that cost you the race — and, because `spawn()` also
clears `finished` and `place`, let a player who had already crossed the line
un-finish themselves and leave the round unable to end. It was rewritten to
snap you to the nearest street, and then removed outright: walking off the grid
already recovers on its own in `stepBody`, so the button was a second answer to
a question that already had one.

Found by the integration suite, and only because it runs against live traffic:

- **riders did not inherit the vehicle's ROTATION**, only its position, so the
  deck turned under them and they were thrown into the road at the first
  corner. A bus route is nothing but corners
- **you could jump out of a moving metro.** The enclosure blocked horizontal
  movement and the jump key clears `riding` unconditionally
- at a crossroads the platform stepped five metres off one street and landed
  squarely on the centre line of the other, so players spawned in traffic and
  were carried off before the clock started. Origins are interchanges and
  interchanges are crossroads, so this hit the START of a round

---

## Time is compressed, distance is not

`TEMPO` in constants.ts is 3. Every speed is multiplied by it and every
duration divided by it, so the city runs three times faster than the real world
while staying exactly the same size. Real-world numbers played like watching a
timetable: the interesting part of this game is the decision, and at real
speeds you spend four fifths of a round waiting to find out whether it was
right.

Compressing time rather than shrinking the city is what keeps every ratio the
design was tuned around: walking is still the same multiple worse than riding,
a transfer still costs the same fraction of a journey, par sits the same
distance from the round timer.

**Two things deliberately do not scale, and both are human rather than
mechanical:**

- **`dwell`** — the seconds a vehicle stands with its doors open. It is your
  window to notice a tram, run, and press a key, and reaction time does not
  speed up when the game does. Divided by three like everything else, a bus
  door would be open for 1.7 seconds, which is not a timing challenge, it is a
  coin toss. `tests/vehicles.test.ts` holds the floor in absolute seconds
  precisely so somebody "tidying up" cannot scale it.
- **`intermissionSeconds`** — reading a scoreboard is not faster on a fast map.

That has one knock-on worth knowing about. Because dwell stays put while
everything else shrinks, stopping becomes a bigger share of a journey and
transit comes out about a fifth slower relative to walking than a straight
third would give. The par window's numerators had to widen to match: scaled by
a plain third, par topped out at 132s against a 133s ceiling and the generator
began rejecting exactly the long multi-change races that are the good ones.

---

## Sprinting is a burst, not a gear

`SHIFT` gives ×1.7 for about three and a half seconds, and takes four times as
long to earn back as to spend.

The shape matters more than the numbers. **A sprint you can hold indefinitely
is just a higher walk speed, and a higher walk speed is a direct attack on the
one thing this whole game rests on — that the network beats your legs.** What a
burst buys instead is a decision made twice a race: the doors are open and you
are forty metres away, do you spend the tank here or keep it for the change at
the far end.

It is sized against the DOORS, which is the only moment it exists for. A bus
stands for four seconds; from forty metres you miss it walking (5.6s) and make
it running (3.3s). One full tank covers 44m — one platform, not one leg of the
journey. `tests/sprint.test.ts` pins both ends of that.

Three details that are each load-bearing:

- **The latch.** Starting a sprint needs `STAMINA.floor` in the tank;
  continuing one only needs something above zero. Without the asymmetry,
  tapping the key every other frame delivers the same speed as holding it but
  as a stutter — and a stutter is both unreadable to everyone watching and the
  sort of thing players discover and then feel obliged to do. With it, holding
  the key covers 510m in 60s in 14 clean runs; tapping covers 508m in 492
  twitches. No faster, and visibly worse.
- **Stamina is the server's number, never predicted.** The client keeps its own
  copy so the local speed is right on the frame you press the key, then defers
  to the server every tick. A predicted resource lets a laggy client sprint
  further than everybody else.
- **`SUSTAINED_WALK`, and the planner uses it.** In steady state you can sprint
  `burst/(burst + recover)` of the time — about a fifth — which is worth 15% on
  a long walk. `routing.ts` costs walking at that speed rather than the base
  one, because vetting every generated race against a number the player beats
  by holding a key would make `par` a comfortable lie. It is derived from the
  sprint and the stamina rather than typed in, so changing either moves the
  planner with it. The street grid had already made walking so much worse
  (1.30x detour) that absorbing this cost the generator nothing measurable.

Riding recovers stamina, which is what makes spending the whole tank on the
first dash affordable.

---

## The street grid, and who has to respect it

`streets.ts` is a rectilinear, irregularly spaced grid, and it does three jobs:

1. **It is the only thing you can walk on.** Blocks are solid. Walking is a
   shortest path over the pedestrian graph, around buildings and via bridges,
   and it averages **1.30x** the distance a ruler gives.
2. **Buses and trams are laid along it**, in staircase routes that turn at
   junctions.
3. **Metros and trains ignore it completely**, because one is underground and
   one is on a viaduct. Between stations they are drawn faded, which is both
   honest about where they are and the reason they are allowed to cut across a
   block that a bus has to drive around.

Their STATIONS are the exception to (3): every stop is snapped onto a street on
the way in, because a station in the middle of a block is a station nobody can
ever board at. That one fails completely silently — nothing throws, the race
is just unwinnable — so `tests/streets.test.ts` checks it on every stop of
every city.

Two bugs came out of this and both have the same shape: **a line's real
geometry is its STOP LIST, not the corridor it was drawn from.** Stops move
after the corridor is validated — they snap to the nearest street, then merge
with anything within 78m — and both moves can invalidate what was checked.

- a corner stop absorbed into a station round the corner deleted the turn, and
  the leg became a diagonal. It showed up as **buses sitting in the middle of
  blocks**
- a stop shuffled to the far bank left a leg **swimming across open water**:
  nine legs in 528, every one of them past a corridor check that had passed

Both are now validated on the finished stop list, and a line that fails is
thrown away and redrawn. Neither cost anything measurable — line counts and
generation attempts did not move.

Making walking obey the streets turned out to *improve* the generator rather
than strain it: strict cities went to 100% on the first attempt every time and
the average race gained most of a change, from 2.25 to 2.9.

---

## There is no "you are here"

The map does not show your own position, and every other change in this
section exists to make that survivable.

A dot on the map turns navigation into following a marker: you never look at
the city, you look at the pip and steer it. Taking it away makes locating
yourself the work — and that only becomes a skill rather than a punishment if
the city can actually be read. So:

- **Every street has a name**, on a plate at every junction, facing down the
  street it names. Twenty-odd names to a city; the plates share a material per
  name, because a hundred and sixty junctions would otherwise mean six hundred
  textures of two dozen words.
- **Every interchange is labelled on the map**, not just the busiest ones, and
  the labels are laid out greedily so none is buried under another. A name you
  cannot read is a name that is not there.

Rivals stay on the map. Watching somebody take the wrong bridge is most of the
point of racing, and if one is standing next to you and gives your position
away, that is something you earned by keeping up with them.

---

## The street shows you nothing about the network

What the street gives you is what a street gives you: roads, buildings, water,
and a station sign with the lines that call there. You need that last part —
standing at a stop you have to know what you can board — but it says nothing
about where any of them GO.

Two things enforce it and both are load-bearing rather than atmospheric:

- **Fog.** It is a design tool, not weather: the reason the network has to be
  looked up and remembered rather than glanced at. It used to close in at 340m,
  which is two blocks and reads as murk. It has been opened up to 720m because
  the wayfinding around it got richer — every street is named and the map no
  longer shows you where you are — so the city is now something you read rather
  than something you squint through. You can see across a few junctions; you
  still cannot see where a line GOES, which is the only property that matters.
- **The map is an object.** A folded card you hold up in front of your face on
  TAB and put away when you let go. It costs you most of your view of the
  street, which is the right price for knowing where the lines go, and it is
  the reason knowing the route is worth something.

The one thing exempt from the fog is the **destination beam** — a column of
light over the target stop, visible from anywhere in the city. Without it a
first-person city is a maze with no compass and the game stops being about
routes and becomes about not getting lost, which is a different and worse game.
It tells you WHERE, never HOW.

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

## The modes have to be guessable

A player must always be able to answer "is the S faster than the M" without
measuring anything. Cruise speed does not settle it: what you actually travel
at is set as much by how often the thing stops, and a train squeezed into
cramped stops by interchange merges came out slower than a good metro in about
**0.1% of line pairs** — rare enough never to notice, often enough to make the
whole hierarchy un-guessable.

`MODES.effMin/effMax` are non-overlapping bands on end-to-end speed, dwells
included, and `addLine` throws away and redraws any corridor that misses its
own band. The ordering is now true by construction: **0 inversions in 907,200
line pairs**. It cost nothing — every city still gets all 18 lines and still
generates on the first attempt.

Two things follow that are easy to get wrong later:

- **Rejecting a line has to rewind the stops it placed.** `addLine` creates
  stations as it goes, and a rejected line used to leave them behind with
  nothing calling at them. That was already a latent leak on the "fewer than
  three stops" path; adding a second rejection reason would have made it
  common. Stop ids are indices and nothing references the new ones until the
  line is committed, so `stops.length = mark` is enough.
- **Door to door is NOT ordered, on purpose.** You wait over two minutes for a
  train, so it loses to the metro over 800m and wins over 2500m. That trade is
  the reason there are four modes rather than a speed slider — but it is only
  fair if the player can see the frequency, which is why the map legend prints
  it next to the speed. `tests/city.test.ts` checks the crossover still sits
  between those two distances.

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
| `MODES.*.effMin/Max` | derived from each mode's nominal speed and non-overlapping by construction — see "the modes have to be guessable". Widen `BAND` until neighbours touch and the hierarchy silently stops being true |
| `TEMPO` | taste, not design — but `dwell` and `intermissionSeconds` must stay in absolute seconds when it changes, and the par window has to widen slightly because of it |
| `WALK.sprint` 1.7 | sized against `MODES.bus.dwell`: the dash has to land inside the doors and the walk has to miss |
| `SUSTAINED_WALK` | derived, never typed in — it is what the planner charges for walking, and it must track the sprint |
| `PLAYER.step` 0.75 | above every vehicle deck, on purpose: boarding is walking on, not platforming |
| `PLAYER.airAccel` / `airDrag` | how much of a moving deck's speed survives a jump. Raise the first much and the momentum stops mattering; that bug shipped once already |
| `BODIES.*.deck` | must stay under `PLAYER.step`, or that mode becomes unboardable without a running jump |
| `BODIES.*.wall` | the whole rail/road distinction. Under a jump's clearance means "you can leave whenever you like"; above it means "you are going to the next station" |
| `BODIES.*.doors` | how much of the dwell you spend walking to an exit. Fewer or narrower is a harder game, not a slower one |
| `RACE.minRail/RoadPenalty` | see "neither half of the network"; drop either and that half of the map becomes padding |
| `PLATFORM.offset` 5 | wider than the widest vehicle's half-width by a clear margin, or waiting at a stop means being scooped up by whatever arrives first |
| `streets.width` 26 | also the tolerance for "is this leg on a street", so the generator's grid check and the player's collision agree by construction |

`tests/city.test.ts` holds the race criteria; `tests/race.test.ts` rides the
planned route against the real timetable and checks it can be followed at all.
That one is the closest thing to a playtest in the repo — if the numbers drift,
it is the suite that will notice first.

---

## Looking at it

`npm run shots` renders `world.ts` and `map.ts` into PNGs with no browser —
both only touch the standard Canvas2D API, so a server-side canvas draws them
exactly as the real one does. It is not a test; it renders and you look.

It earned its place immediately. The first time it was pointed at the network
map it found five things that were invisible from the code and obvious in the
picture:

- the **legend was underneath the status panel** — the one thing explaining
  what a coloured line meant was the one thing you could not see. HUD panels
  that collide with it now fade out while the map is held
- the **A and B badges were under the player pips** standing on them, every
  round, at the start and at the end. They are rings with the letter hung off
  one shoulder now, and they are drawn last
- the **river read as another tram line** — eleven pixels of solid teal on a
  diagram whose whole job is telling coloured lines apart. Wide, dim and blue
  is unmistakably terrain
- the **bus's seven line badges ran straight through "24 km/h · every 0:41"**,
  which is the exact number the legend exists to show
- **labels were being overdrawn by whatever moved past them.** Station names
  now go on last in both views, and a dwelling vehicle puts its line number
  BELOW itself, because above is where the station's own name lives

The lesson is not any of those five. It is that none of them would ever have
shown up in a test, a typecheck or a build, and all five were the first thing
you saw in the picture.

---

## Deliberate simplifications

Written down so they are choices rather than surprises:

- **Vehicles still do not collide with each other.** Lanes and stands take
  interpenetration at a stop from 12.8% to 3.4% and remove it entirely between
  opposing traffic, but the residue is real: more than four lines at one stop
  start reusing stands, and two routes crossing at a junction have nowhere to
  go. Fixing it properly means queueing, which means vehicles stop being a pure
  function of the clock.
- **Buildings are not collision volumes.** Walking is confined to the streets,
  which is a stronger constraint and a much cheaper one, so a building is only
  ever drawn. The one place it shows is that rail alignments would otherwise
  drive through office blocks, which the renderer solves by not drawing
  buildings on them.
- **Other players are drawn from interpolated state**, not snapped to the
  vehicle they are riding, so a passenger on a fast train reads a few metres
  behind it.
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

## The departure board is currently off

Commented out, not deleted — in `index.html` and in `main.ts`, with
`departures()` in shared/vehicles.ts still live and still tested.

It listed what was leaving from under your feet and when. The argument for
pulling it is that the map already shows every vehicle in the city live, so it
was a convenience layer over information the player already has; without it you
have to look at the network and work out what is coming, which is the game.

The argument against, for when this is revisited: **the board was the only
thing that ever told you which DIRECTION a vehicle was going.** On the map a
tram approaching your stop and one leaving it look identical until you watch it
for a second, and boarding the right line the wrong way is the most common way
to lose one of these races. If the board stays out, direction has to become
legible somewhere else.

---

## Where it goes next

In rough order of how much each would buy:

1. **Playtest with three people.** Everything above is measured, none of it is
   played. The specific unknown is whether *watching a rival's pip take the
   wrong bridge* is as good as it sounds.
2. **Decide about direction.** See the departure board note above — this is the
   one open question the current build has no answer to.
3. **A reason to look at other players.** Right now they are information you
   can ignore. The nearest cheap idea: show which vehicle each rival is on, so
   a confident-looking rival is a hypothesis about the route.
4. **Disruption.** One line suspended mid-round, announced on the boards, would
   make the map worth re-reading halfway through. It has to stay a function of
   the seed and the clock.
5. **Round-to-round structure.** Best of five across five cities, scoring by
   margin rather than position.
6. **A line with a branch**, once "next stop" has a good answer in the HUD.
7. **Vehicles that queue rather than overlap**, if it can be done without
   giving up the pure-function timetable.
