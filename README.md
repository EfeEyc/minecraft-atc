# ✈️ ATC Radar & AWOS System

A visual Aerodrome Controller training tool to be used with Minecraft, it is fully ai-made, i am NOT a programmer.

---

## 🚀 Features

- **Real-Time Radar Display**: Interactive radar scope with the ability to control in-game aircraft.
- **VERY EXPERIMENTAL VR VERSION**: The radar scope accesible in WebXR for the sake of it, **VERY UNFRIENDLY TO USE**.
- **AWOS Integration**: Weather observation display that is editable live and used by the controller
- **Configurable Generator**: Automatically generates random traffic strips based on templates selected by the user.

---

## 📋 Requirements

- Python 3.8+
- Flask
- `mcrcon`
- Minecraft 1.20.1 (other versions not tried, might work)
- The datapack installed in your world file.

---

## 🔌 Required Mods

- [SimplePlanes](https://www.curseforge.com/minecraft/mc-mods/simpleplanes) mod to spawn planes.
- [Automobility and RIAutomobility](https://www.curseforge.com/minecraft/mc-mods/automobility), (https://www.curseforge.com/minecraft/mc-mods/riautomobility) mods for ground vehicles.
- [BlueMap](https://www.curseforge.com/minecraft/mc-mods/bluemap) if you want to use the VR version of the site.
- [Xaero's World Map](https://www.curseforge.com/minecraft/mc-mods/xaeros-world-map) to use OpenPAC and to get the map image onto the radar.

---

## ⭐ Recommended Mods

- [WebDisplays](https://www.curseforge.com/minecraft/mc-mods/webdisplays) mod to display the radar and awos in Minecraft.
- [OpenPAC](https://www.curseforge.com/minecraft/mc-mods/open-parties-and-claims) to make forceloading chunks easier.
- [Vivecraft](https://www.curseforge.com/minecraft/mc-mods/vivecraft) for VR support on the Minecraft side. You don't need this to use the VR version of the site.

---

## 🛠️ Getting Started

1. **Install dependencies:**
   ```bash
   pip install flask mcrcon
   ```
2. **Make a superflat world** **IMPORTANT** it HAS to be superflat for the datapack to work, it's hardcoded for the ground to be at y=-59.
3. **In your minecraft server.properties file**, set enable-rcon to true and rcon-password to your desired password.
4. **in atc.py**, go to line 41 and enter the server's RCON details.
5. **Go into your Minecraft server** and forceload EVERY CHUNK a plane will fly in, if a plane ever goes out of loaded chunks it will disappear. you can use the open parties and claims mod to make forceloading a little easier.
6. **Launch the radar server:**
   if you want to use the VR version on the meta quest browser, you need HTTPS protocol.
   - **there is an https mode** but it doesn't work in my case, again, i'm not a programmer: `start_https.bat` or run:
     ```bash
     python atc.py --https
     ```
   - **the regular http mode** works just fine:
     ```bash
     python atc.py
     ```
7. **Access the web dashboard** in your browser:
   - **Radar Display**: `http://localhost:5000/`
   - **Weather Display**: `http://localhost:5000/awos` you can utilize the WebDisplays mod to put this display in Minecraft.
   - **VR Display**: `http://localhost:5000/vr` **VERY UNFRIENDLY TO USE**.
8. **Set up Minecraft Command Blocks in your world:**
   For automatic radar tracking and entity synchronization, place **Command Blocks** in your world running the following commands:

   #### 1. Entity Auto-Trackers (Repeating Command Blocks, Always Active)
   - **Planes**: `tag @e[type=simpleplanes:plane,tag=!tracked] add tracked`
   - **Large Planes**: `tag @e[type=simpleplanes:large_plane,tag=!tracked] add tracked`
   - **Helicopters**: `tag @e[type=simpleplanes:helicopter,tag=!tracked] add tracked`
   - **Automobiles / Cars**: `tag @e[type=automobility:automobile,tag=!tracked] add tracked`
   - **Biplanes**: `tag @e[type=immersive_aircraft:biplane,tag=!tracked] add tracked`

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

9. **Set the generator settings** in the settings menu.
10. **Export a map.png** using Xaero's World Map and upload it.
11. **Calibrate your map image** using the **CALIBRATION** button. To calibrate, go to a specific block in game, get the coordinates, click that same block on the map inside the radar, and type in the coordinates of that spot in game. Repeat for one more point.

---

## 🎮 Usage

Every Aircraft and Ground vehicle move to set waypoints that you can place. You can place waypoints using the **CREATOR MODE** button.

You can spawn vehicles by ALT + CLICKing anywhere on the map, they will always spawn on the ground (y=-59).
Spawned aircraft will get callsigns automatically assigned based on the generator settings you have set.

To control aircraft, click on the aircraft, select the route by clicking the placed waypoints you want that vehicle to move to, and use one of the buttons, **TAXI** will teleport the aircraft to the ground and is a slower speed than the **FLY**. The **TP** button will teleport the vehicle to the LAST selected waypoint.

You can pause everything by clicking the Radar System button in the top left, it will indicate the current state by either saying **LIVE** or **HALTED**.

---

## 📝 Note

I am mostly done with this project, I made this for the sole purpose of passing my aerodrome control exams and it is a surprisingly effective tool. I won't ever be adding new features or fixing bugs, if anyone cares enough they can do that.

---

## 📄 License

MIT License
