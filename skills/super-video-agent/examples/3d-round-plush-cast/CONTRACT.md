# EXAMPLE contract: what the cast GLBs promise a film page

This is the worked contract for this one example cast. It lists the names, sizes and rules a page
relies on. Another cast needs its own contract with its own numbers; the shape of the table is
what carries over (`references/3d.md`).

Files: `<out>/models/bear.glb`, `cat.glb`, `rabbit.glb`, `puppy.glb`, `pancake.glb`,
`props-small.glb`, `props-set.glb`, `props-town.glb` (written by `make_cast.py`).

## Characters

| Character | Look | Faces (`face_<name>`) | Sockets |
|---|---|---|---|
| bear | base biped (bounds x ±0.560, y −0.011…1.780, z −0.520…0.595), coral ribbon on her left ear, lashes on the faces, apron | smile, talk, happy, wink, blink, sleep | `hold_L`, `hold_R` |
| cat | cream fur F7E6CC with tabby marks, lavender cardigan D3B9EA over a white V, rose beret, whiskers, thin tail, head ×1.12 wide | smile, talk, happy, blink | `hold_L`, `hold_R` |
| rabbit | white fur, pastel-yellow top with daisies, straw sun hat with a pink band, Peter Pan collar with a pink bow, left ear bent | smile, talk, happy, blink | `hold_L`, `hold_R` |
| puppy | cream F0CFA0, floppy ears, red collar with a tag, curled tail; about 0.65 tall | smile, happy, blink | `leash_ring` |

The three bipeds share one skeleton (plus `tail1`, `tail2`) and the same 19 clips.
Show exactly one face node; hide the rest. `acc_nightcap` is hidden except in the bedroom.

## Clips (30 fps; seconds)

| Clip | s | Use |
|---|---|---|
| Idle | 2.03 | standing breath, loop |
| Chat | 3.03 | talking gesture, loop |
| Walk | 0.70 | loop |
| WalkLeash | 0.70 | walk with the right paw forward holding the leash |
| Wave | 0.83 | forearm wag, arm sideways-forward ≤ 115° |
| SitIdle · SitWave | 2.03 · 0.83 | seated idle; seated wave |
| SitPhoto | 1.03 | both paws in front of the chest, leaning 8° to the plate |
| SitSip | 2.03 | right paw lifts the cup to the mouth |
| SelfieHold · SelfieWave | 2.03 · 0.83 | right arm forward (the phone is the camera); + free-paw wave |
| LiftLid | 1.23 | lid lifted at 0.73 s |
| FlipBoard | 1.03 | flips the door board |
| Promise | 1.03 | paw toward the lens |
| ShowPlate | 2.03 | left paw raises the plate beside the face, right arm in selfie |
| Serve | 2.03 | two-paw carry at the chest |
| HappyBounce | 0.70 | small hop |
| Sleep | 3.03 | lying breath, loop |
| SleepSnuggle | 0.70 | paws in over the belly, head rolls into the pillow |
| puppy: Idle · Trot · Sit · SitWag · Happy | 2.03 · 0.43 · 2.03 · 1.10 · 0.43 | four-legged rig |
| pancake: Rest · Idle · Jiggle · Wobble · Land | 0.07 · 2.03 · 1.23 · 1.83 · 0.83 | Rest = still; Wobble = layers top-first; Land = plate set down |

## Rules for the film page

- **Node names.** GLTFLoader strips dots from names: the joint `hand.R` is `handR`. Sockets, faces,
  props and sub-nodes use underscores and keep their names.
- **Time.** Pose with `mixer.setTime(t)` on every seek; never advance a mixer by frame deltas.
- **Sitting.** Put the character's origin on the seat top; the sit clips drop the root 0.12 so the
  body rests there. `prop_chair_mint` / `prop_chair_pink` seat top = chair base + 0.42.
  `prop_cafe_table` top = base + 0.834. `prop_counter` top = 0.55. `prop_deck_tile` top = 0.06.
- **Pancake sizes.** On a café table scale 1.15; on the raised paw (ShowPlate) 1.0.
- **Holding (level hold).** Place the prop at the socket's world position (two-paw props: the
  midpoint of `hold_L` and `hold_R`), rotated with the character's root, plus the offset below in
  the character's frame. Recompute every seek after the mixer. `holdLevel()` in
  `testbed/reel.html` is the reference code.

| Clip | Prop | Sockets | Offset (x, y, z) | Rotation (Euler XYZ) |
|---|---|---|---|---|
| SelfieHold | `prop_phone` | hold_R | 0, 0.04, 0 | 0, π, 0 (screen toward the character) |
| SitPhoto | `prop_phone_cat` | hold_L + hold_R | 0, 0, 0.10 | 0.35, π, 0 (camera tipped to the plate) |
| ShowPlate | pancake (plate) | hold_L | 0, 0.01, 0 | 0, 0, 0 |
| LiftLid | `prop_cloche` | hold_R | 0, 0.03 − lid height, 0 | 0, 0, 0 (paw on the knob) |
| SitSip | `prop_iced_latte` | child of hold_R | 0, −0.12, 0 | none: tilts with the paw, which is the sip |

- **Leash.** A tube from the rabbit's `hold_R` to the puppy's `leash_ring`, rebuilt every seek:
  radius 0.012, colour E0785A, midpoint sagging 0.18.
- **Bed.** Add the bear to `prop_bed` → `sleep_spot` with an identity transform: she lies on her
  back, head sunk in the pillow. `prop_bed_quilt` has one morph target, `up` (index 0): 0 = tucked
  to her chin, 1 = over her eyes with her toe tips out. Drive it 0 → 1 over the 0.70 s of
  SleepSnuggle. The generator drapes the quilt over her real Sleep and SleepSnuggle poses.
- **Cover mask on the bed.** Cover = `prop_bed_quilt`, base plane = `prop_bed`'s local XZ, mask
  half-size 1.7. Tagged (hidden inside the quilt's footprint): the vertices of `Body` weighted to
  `thighL`, `thighR`, `shinL`, `shinR`, `footL`, `footR`, `spine`, `chest`, `tail1`, `tail2`, the
  arm bones (`shoulder*`, `upper_arm*`, `forearm*`, `hand*`; the sleep clips keep the paws on the
  belly under the quilt), and the whole `outfit` node. Not tagged: `head`, `neck`, the `face_*`
  nodes and `acc_nightcap`; they come out. A shot with paws on top of the quilt leaves the arm
  bones untagged. `testbed/reel.html` (`bedroomMotion`) is the reference code.
- **Decals.** `face_*` and `outfit` are alpha BLEND: `renderOrder` 1, `depthWrite` false
  (`orderDecals()` in the testbed).
- **Sub-nodes to animate.** `prop_door_leaf` and `shop_door_leaf` (hinge on the leaf edge, rotate
  y), `prop_door_board` / `shop_door_board` (swing from the rope top), `prop_door_bell` /
  `shop_door_bell`, `shop_sign`, `prop_alarm_clock_hand_h/_m`, `prop_wall_clock_hand_h/_m`,
  `prop_phone_flash` / `prop_phone_cat_flash`, `prop_window_glass`.
  `prop_syrup_stream` is one unit long, pointing down: scale y to the pour length.
- **Town scale.** Houses, station, train and track are scaled ×1.7 in the generator so their doors
  and cars match the café, whose door fits the bear. A track segment is 6.8 m; the train sits at
  y 0.17.
- **Sky and light.** Background = painted gradient (#8cc9ee top, #bfe3f5, #fbe9cf from the horizon
  down), `gradientSky()` in the testbed. A CC0 sky HDRI is the PMREM environment only: as a
  backdrop its grey clouds read gloomy. NeutralToneMapping, PCF soft shadows.
- **Foliage.** Downloaded CC0 trees (Quaternius), restyled in the page by `restyleFoliage()`:
  leaves get `emissiveMap = map`, emissive white at 0.38, roughness 1, no normal map (lighter and
  softer, same hues); bark F3D6B8. Flowers come from the generator: `prop_flowers_pink` /
  `_butter` / `_lav` at scale 1.3, with `prop_hedge`, `prop_planter`, `prop_pot_topiary`. The
  pack's autumn-red bush and its flat flower and grass cards were left out next to this cast.
