# ✈️ ATC Radar & AWOS System

A visual Aerodrome Controller training tool to be used with Minecraft, it is fully ai-made, i am NOT a programmer.

---

## Features

- **Real-Time Radar Display**: Interactive radar scope with the ability to control in-game aircraft.
- **VERY EXPERIMENTAL VR VERSION**: The radar scope accesible in WebXR for the sake of it, **VERY UNFRIENDLY TO USE**.
- **AWOS Integration**: Weather observation display that is editable live and used by the controller
- **Configurable Generator**: Automatically generates random traffic strips based on templates selected by the user.

---

## Requirements

- Python 3.8+
- Flask
- `mcrcon`
- Minecraft 1.20.1 (other versions not tried, might work)
- The datapack installed in your world file.

---

## Required Mods

- [SimplePlanes](https://www.curseforge.com/minecraft/mc-mods/simpleplanes) mod to spawn planes.
- [Automobility and RIAutomobility](https://www.curseforge.com/minecraft/mc-mods/automobility), (https://www.curseforge.com/minecraft/mc-mods/riautomobility) mods for ground vehicles.
- [BlueMap](https://www.curseforge.com/minecraft/mc-mods/bluemap) if you want to use the VR version of the site.
- [Xaero's World Map](https://www.curseforge.com/minecraft/mc-mods/xaeros-world-map) to use OpenPAC and to get the map image onto the radar.

---

## Recommended Mods

- [WebDisplays](https://www.curseforge.com/minecraft/mc-mods/webdisplays) mod to display the radar and awos in Minecraft.
- [OpenPAC](https://www.curseforge.com/minecraft/mc-mods/open-parties-and-claims) to make forceloading chunks easier.
- [Vivecraft](https://www.curseforge.com/minecraft/mc-mods/vivecraft) for VR support on the Minecraft side. You don't need this to use the VR version of the site.

---

## 🛠️ Getting Started

1. **Install dependencies:**
   ```bash
   pip install flask mcrcon
   ```
2. **Make a superflat world**: **IMPORTANT** — it HAS to be superflat for the datapack to work (hardcoded ground level at `y=-59`).
3. **Install the datapack**: Copy/extract `datapack.zip` into your server's `world/datapacks/` directory.
4. **Configure `server.properties`**: Set `enable-rcon=true` and set `rcon.password` to your desired password.
5. **Configure `atc.py`**: Update line 41 with your server's RCON IP, port, and password.
6. **Forceload chunks**: In your Minecraft server, forceload every chunk where planes will operate (e.g. using OpenPAC).
7. **Launch the radar server:**
   - **Standard HTTP mode**:
     ```bash
     python atc.py
     ```
   - **HTTPS mode** (for Meta Quest / WebXR browser):
     ```bash
     python atc.py --https
     ```
8. **Access the web dashboard**:
   - **Radar Display**: `http://localhost:5000/`
   - **Weather Display (AWOS)**: `http://localhost:5000/awos`
   - **VR Display**: `http://localhost:5000/vr`
9. **Set up Minecraft Command Blocks in your world:**
   Place **Command Blocks** in your world running the following 8 commands:

   #### 1. Entity Auto-Trackers (Repeating Command Blocks, Always Active)
   - **Plane**: `tag @e[type=simpleplanes:plane,tag=!tracked] add tracked`
   - **Large Plane**: `tag @e[type=simpleplanes:large_plane,tag=!tracked] add tracked`
   - **Helicopter**: `tag @e[type=simpleplanes:helicopter,tag=!tracked] add tracked`
   - **Automobiles / Cars**: `tag @e[type=automobility:automobile,tag=!tracked] add tracked`
   - **Biplane**: `tag @e[type=immersive_aircraft:biplane,tag=!tracked] add tracked`

   #### 2. Automatic ID & Telemetry (Repeating Command Blocks, Always Active)
   - **Auto-Assign `plane_id` Counter**:
     ```minecraft
     execute as @e[tag=tracked] unless score @s plane_id matches 1.. store result score @s plane_id run scoreboard players add #GLOBAL plane_id 1
     ```
   - **Waypoint Pos X Sync**:
     ```minecraft
     execute as @e[tag=waypoint] store result score @s wp_x run data get entity @s Pos[0]
     ```
   - **Waypoint Pos Z Sync**:
     ```minecraft
     execute as @e[tag=waypoint] store result score @s wp_z run data get entity @s Pos[2]
     ```

10. **Configure generator settings** in the radar UI settings menu.
11. **Export and upload `map.png`** using Xaero's World Map.
12. **Calibrate your radar map** using the **CALIBRATION** button by picking two known in-game coordinates.

---

## Usage

Every Aircraft and Ground vehicle move to set waypoints that you can place. You can place waypoints using the **CREATOR MODE** button.

You can spawn vehicles by ALT + CLICKing anywhere on the map, they will always spawn on the ground (y=-59).
Spawned aircraft will get callsigns automatically assigned based on the generator settings you have set.

To control aircraft, click on the aircraft, select the route by clicking the placed waypoints you want that vehicle to move to, and use one of the buttons, **TAXI** will teleport the aircraft to the ground and is a slower speed than the **FLY**. The **TP** button will teleport the vehicle to the LAST selected waypoint.

You can pause everything by clicking the Radar System button in the top left, it will indicate the current state by either saying **LIVE** or **HALTED**.

---

## Note

I am mostly done with this project, I made this for the sole purpose of passing my aerodrome control exams and it is a surprisingly effective tool. I won't ever be adding new features or fixing bugs, if anyone cares enough they can do that.

---

## License

MIT License
