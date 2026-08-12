from flask import Flask, request, jsonify, render_template, send_from_directory
import re
import random
import string
import time
import math
import signal
import mcrcon
import select
import struct
import threading
import json
import os

# --- mcrcon Patch for large packets ---
def patched_send(self, out_type, out_data):
    if self.socket is None: raise mcrcon.MCRconException("Must connect before sending data")
    out_payload = struct.pack("<ii", 0, out_type) + out_data.encode("utf8") + b"\x00\x00"
    out_length = struct.pack("<i", len(out_payload))
    self.socket.send(out_length + out_payload)
    in_data = ""
    while True:
        (in_length,) = struct.unpack("<i", self._read(4))
        in_payload = self._read(in_length)
        in_id, in_type = struct.unpack("<ii", in_payload[:8])
        in_data_partial, in_padding = in_payload[8:-2], in_payload[-2:]
        if in_padding != b"\x00\x00": raise mcrcon.MCRconException("Incorrect padding")
        if in_id == -1: raise mcrcon.MCRconException("Login failed")
        in_data += in_data_partial.decode("utf8")
        if len(select.select([self.socket], [], [], 0.5 if in_length >= 4096 else 0)[0]) == 0:
            return in_data
mcrcon.MCRcon._send = patched_send

# we're basically tricking the library into thinking it's in the main thread
def dummy_handler(signum, frame): pass
signal.signal = lambda s, h: dummy_handler # hijack the signal function

app = Flask(__name__)

# --- CONFIGURATION ---
RCON_IP = 'localhost' 
RCON_PORT = 25575
RCON_PASS = 'purna'

# --- GLOBAL MEMORY ---
AWOS_STATE = {
    "windDir": 340,
    "windSpd": 12,
    "windGust": 0,
    "temp": 18,
    "dew": 10,
    "qnh": 1013,
    "qfe": 898,
    "vis": 9999,
    "tempoTrigger": 0,
    "keepGoingTrigger": 0
}
TRACKER = {} 
QUARANTINE = {} # { "id": { "seen_start": 170000.0, "data": {...} } }
FLIGHT_DB = {}
LAST_SIM_STATUS = 0 
EMPTY_RESPONSE_STREAK = 0 
SERVER_WEATHER = "clear"

STUDENT_SCORE = 100
SCORE_HISTORY = []

GENERATOR_SETTINGS = {
    "aircraft_types_vfr": [],
    "aircraft_types_ifr": [],
    "heli_types": [],
    "airports": [],
    "callsign_format_aircraft_vfr": [],
    "callsign_format_aircraft_ifr": [],
    "callsign_format_heli": [],
    "map_x": -265,
    "map_z": 72,
    "map_scale": 1.0,
    "map_opacity": 0.5,
    "map_rotation": 180,
    "awos_rwy_top": "03",
    "awos_rwy_bottom": "21",
    "awos_rwy_rotation": 30,
    "awos_airport_id": "LTAC",
    "awos_default_qfe": 898
}

SETTINGS_FILE = 'generator_settings.json'
try:
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE, 'r') as f:
            saved_settings = json.load(f)
            for k, v in saved_settings.items():
                if k in GENERATOR_SETTINGS:
                    GENERATOR_SETTINGS[k] = v
except Exception as e:
    print(f"Failed to load generator settings: {e}")

AWOS_STATE["qfe"] = GENERATOR_SETTINGS.get("awos_default_qfe", 898)

def execute_batch(commands):
    from mcrcon import MCRcon
    try:
        # We use a standard socket timeout (seconds)
        with MCRcon(RCON_IP, RCON_PASS, port=RCON_PORT, timeout=10) as mcr:
            return [mcr.command(cmd) for cmd in commands]
    except Exception as e:
        print(f"RCON ERROR: {e}")
        return None

def parse_rcon_output(response):
    if not response or "No tracked" in response or "Unknown" in response: return {}
    pattern = r"([^\s,]+)\s+has\s+(-?\d+)"
    return {name: int(value) for name, value in re.findall(pattern, response)}

def parse_ids_only(response):
    if not response or "No tracked" in response: return []
    pattern = r"has\s+(-?\d+)"
    return [str(val) for val in re.findall(pattern, response)]

def generate_callsign(format_str):
    if not format_str: return "UNKNOWN"
    result = ""
    for char in format_str:
        if char == 'X': result += random.choice(string.ascii_uppercase)
        elif char == '#': result += random.choice(string.digits)
        else: result += char
    return result

def generate_flight_data(plane_id, is_helicopter=False, flight_rules="VFR"):
    if is_helicopter and GENERATOR_SETTINGS.get("heli_types"):
        ac_type = random.choice(GENERATOR_SETTINGS["heli_types"])
        fmt_list = GENERATOR_SETTINGS.get("callsign_format_heli", [])
        if isinstance(fmt_list, str): fmt_list = [fmt_list]
        callsign = generate_callsign(random.choice(fmt_list) if fmt_list else "UNKNOWN")
    elif not is_helicopter:
        if flight_rules == "IFR":
            ac_types = GENERATOR_SETTINGS.get("aircraft_types_ifr", [])
            ac_type = random.choice(ac_types) if ac_types else "UNKNOWN"
            fmt_list = GENERATOR_SETTINGS.get("callsign_format_aircraft_ifr", [])
            if isinstance(fmt_list, str): fmt_list = [fmt_list]
            callsign = generate_callsign(random.choice(fmt_list) if fmt_list else "UNKNOWN")
        else:
            ac_types = GENERATOR_SETTINGS.get("aircraft_types_vfr", [])
            ac_type = random.choice(ac_types) if ac_types else "UNKNOWN"
            fmt_list = GENERATOR_SETTINGS.get("callsign_format_aircraft_vfr", [])
            if isinstance(fmt_list, str): fmt_list = [fmt_list]
            callsign = generate_callsign(random.choice(fmt_list) if fmt_list else "UNKNOWN")
    else:
        ac_type = "UNKNOWN"
        callsign = "UNKNOWN"

    route = ""
    airports = GENERATOR_SETTINGS.get("airports", [])
    if len(airports) > 0:
        route = random.choice(airports)

    return {
        "callsign": callsign,
        "type": ac_type,
        "route_text": route,
        "squawk": "1" + "".join([str(random.randint(0, 7)) for _ in range(3)]),
        "custom_callsign": "", "gate": "", "active_wp_route": [],
        "category": "undefined", "started_up": False,
        "speed": 2,
        "time_tracker": {"takeoff": None, "landing": None, "go_around": None},
        "untracked": False,
        "sid": "", "airways": "", "pfl": ""
    }

@app.route('/')
def index(): return render_template('index.html')

@app.route('/vr')
def vr_display(): return render_template('vr.html')

@app.route('/awos')
def awos_display(): return render_template('awos.html')

@app.route('/awos_main')
def awos_main(): return render_template('awos_main.html')

@app.route('/get_generator_settings')
def get_generator_settings(): return jsonify(GENERATOR_SETTINGS)

@app.route('/update_generator_settings', methods=['POST'])
def update_generator_settings():
    global GENERATOR_SETTINGS
    d = request.json
    for k, v in d.items():
        if k in GENERATOR_SETTINGS:
            GENERATOR_SETTINGS[k] = v
            
    try:
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(GENERATOR_SETTINGS, f, indent=4)
    except Exception as e:
        print(f"Failed to save settings: {e}")
        
    return jsonify({"status": "ok"})

@app.route('/get_awos')
def get_awos(): return jsonify(AWOS_STATE)

@app.route('/update_awos', methods=['POST'])
def update_awos():
    global AWOS_STATE
    d = request.json
    for k, v in d.items():
        AWOS_STATE[k] = v
    return jsonify({"status": "ok"})

@app.route('/map.png')
def serve_map(): return send_from_directory('.', 'map.png')

@app.route('/upload_map', methods=['POST'])
def upload_map():
    if 'file' not in request.files:
        return jsonify({"status": "error", "message": "No file part"}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({"status": "error", "message": "No selected file"}), 400
    if file and file.filename.endswith('.png'):
        file.save('map.png')
        return jsonify({"status": "ok"})
    return jsonify({"status": "error", "message": "Invalid file type (PNG only)"}), 400

@app.route('/get_radar')
def get_radar():
    global LAST_SIM_STATUS, TRACKER, QUARANTINE, EMPTY_RESPONSE_STREAK, SERVER_WEATHER
    
    # Standard Selector (Armor Stands Allowed again)
    base_selector = "@e[scores={plane_id=-2147483648..}]"
    
    cmds = [
        "scoreboard players get #GLOBAL sim_status",
        f"execute as {base_selector} run scoreboard players get @s plane_id",
        f"execute as {base_selector} run scoreboard players get @s pos_x",
        f"execute as {base_selector} run scoreboard players get @s pos_z",
        f"execute as {base_selector} run scoreboard players get @s rot_y",
        f"execute as {base_selector} run scoreboard players get @s current_target",
        f"execute as {base_selector} if entity @s[tag=taxiing] run scoreboard players get @s plane_id",
        f"execute as {base_selector} if entity @s[tag=flying] run scoreboard players get @s plane_id",
        f"execute as @e[type=automobility:automobile,scores={{plane_id=-2147483648..}}] run scoreboard players get @s plane_id",
        "execute as @e[tag=FOLLOWME] run scoreboard players get @s plane_id",
        "execute as @e[tag=TRUCK] run scoreboard players get @s plane_id",
        "execute as @e[type=simpleplanes:helicopter,scores={plane_id=-2147483648..}] run scoreboard players get @s plane_id",
        f"execute as {base_selector} run scoreboard players get @s speed",
        f"execute as {base_selector} run scoreboard players get @s pos_y",
        "scoreboard objectives add pos_y dummy"
    ]
    
    results = execute_batch(cmds)
    current_time = time.time()
    
    # IDs confirmed to exist in THIS exact server tick
    ids_in_this_frame = set()

    if results:
        if "has" in results[0]:
            match = re.search(r"has\s+(-?\d+)", results[0])
            if match: LAST_SIM_STATUS = int(match.group(1))

        id_map = parse_rcon_output(results[1])
        
        # Glitch Filter (Ignore "0 planes" result if it's brief)
        if not id_map:
            EMPTY_RESPONSE_STREAK += 1
        else:
            EMPTY_RESPONSE_STREAK = 0

        if EMPTY_RESPONSE_STREAK < 4:
            x_map  = parse_rcon_output(results[2])
            z_map  = parse_rcon_output(results[3])
            rot_map = parse_rcon_output(results[4])
            target_map = parse_rcon_output(results[5])
            taxi_ids = parse_ids_only(results[6])
            fly_ids  = parse_ids_only(results[7])
            automobile_ids = parse_ids_only(results[8]) if len(results) > 8 else []
            followme_ids = parse_ids_only(results[9]) if len(results) > 9 else []
            truck_ids = parse_ids_only(results[10]) if len(results) > 10 else []
            heli_ids = parse_ids_only(results[11]) if len(results) > 11 else []
            speed_map = parse_rcon_output(results[12]) if len(results) > 12 else {}
            y_map = parse_rcon_output(results[13]) if len(results) > 13 else {}
            
            for uuid, p_id in id_map.items():
                if uuid in x_map and uuid in z_map:
                    p_id_str = str(p_id)
                    ids_in_this_frame.add(p_id_str)
                    
                    # Entity is automobile if it IS in the automobile list
                    is_automobile = p_id_str in automobile_ids
                    is_helicopter = p_id_str in heli_ids
                    
                    if p_id_str not in FLIGHT_DB:
                        if is_automobile:
                            callsign = ""
                            if p_id_str in followme_ids: callsign = "FOLLOWME"
                            elif p_id_str in truck_ids: callsign = "TRUCK"
                            
                            FLIGHT_DB[p_id_str] = {
                                "callsign": callsign, "type": "", "route_text": "",
                                "squawk": "", "custom_callsign": callsign, "gate": "",
                                "entity_type": "automobile",
                                "category": "ground", "started_up": False,
                                "speed": 2,
                                "time_tracker": {"takeoff": None, "landing": None, "go_around": None},
                                "untracked": False
                            }
                        else:
                            # If they randomly appear without being spawned by UI, default to VFR
                            fd = generate_flight_data(p_id, is_helicopter, "VFR")
                            if is_helicopter:
                                fd["type"] = fd["type"] # Keeps the heli type or "UNKNOWN"
                            fd["entity_type"] = "aircraft"
                            FLIGHT_DB[p_id_str] = fd
                    
                    info = FLIGHT_DB[p_id_str]
                    if info.get('untracked', False):
                        continue
                    
                    status = "idle"
                    if p_id_str in taxi_ids: status = "taxi"
                    elif p_id_str in fly_ids: status = "fly"
                    
                    if uuid in speed_map:
                        info['speed'] = speed_map[uuid]

                    plane_data = {
                        "id": p_id_str,
                        "x": x_map[uuid],
                        "y": y_map.get(uuid, -60),
                        "z": z_map[uuid],
                        "heading": rot_map.get(uuid, 0),
                        "current_target": target_map.get(uuid, 0),
                        "status": status,
                        "callsign": info['callsign'], "type": info['type'],
                        "route": info['route_text'], "squawk": info['squawk'],
                        "custom_callsign": info['custom_callsign'], "gate": info['gate'],
                        "entity_type": info.get('entity_type', 'aircraft'),
                        "active_wp_route": info.get('active_wp_route', []),
                        "category": info.get('category', 'arrival'),
                        "started_up": info.get('started_up', False),
                        "speed": info.get('speed', 2),
                        "time_tracker": info.get('time_tracker', {"takeoff": None, "landing": None, "go_around": None}),
                        "sid": info.get('sid', ''),
                        "airways": info.get('airways', ''),
                        "pfl": info.get('pfl', '')
                    }
                    
                    # --- LOGIC GATE ---
                    
                    # Case A: Already Tracked? Update it immediately.
                    if p_id_str in TRACKER:
                        TRACKER[p_id_str] = { "seen": current_time, "data": plane_data }
                        
                    # Case B: Not Tracked? Check Quarantine.
                    else:
                        if p_id_str in QUARANTINE:
                            # It is already in quarantine. Check time.
                            first_seen = QUARANTINE[p_id_str]["seen_start"]
                            
                            # VERIFICATION TIME: 2.0 Seconds
                            if current_time - first_seen > 2.0:
                                # PASSED! Promote to Tracker
                                TRACKER[p_id_str] = { "seen": current_time, "data": plane_data }
                                del QUARANTINE[p_id_str]
                            else:
                                # Update data but keep waiting
                                QUARANTINE[p_id_str]["data"] = plane_data
                        else:
                            # New Contact! Add to Quarantine.
                            QUARANTINE[p_id_str] = { "seen_start": current_time, "data": plane_data }

    # --- CLEANUP ---

    # 1. Clean Quarantine
    # If a Quarantined plane STOPS sending data (it was a glitch), delete it.
    q_to_delete = []
    for pid in QUARANTINE:
        if pid not in ids_in_this_frame:
            q_to_delete.append(pid)
    for pid in q_to_delete:
        del QUARANTINE[pid]

    # 2. Clean Tracker (Zombie Mode)
    # Keep real planes alive for 3s if they flicker out
    final_planes = []
    t_to_delete = []
    
    for pid, entry in TRACKER.items():
        if current_time - entry['seen'] < 3.0:
            final_planes.append(entry['data'])
        else:
            t_to_delete.append(pid)

    for pid in t_to_delete:
        del TRACKER[pid]
        
    return jsonify({
        "planes": final_planes, 
        "sim_paused": (LAST_SIM_STATUS == 1),
        "weather": SERVER_WEATHER,
        "student_score": STUDENT_SCORE,
        "score_history": SCORE_HISTORY,
        "map_settings": {
            "x": GENERATOR_SETTINGS["map_x"],
            "z": GENERATOR_SETTINGS["map_z"],
            "scale": GENERATOR_SETTINGS["map_scale"],
            "rotation": GENERATOR_SETTINGS["map_rotation"]
        }
    })

# ... [Keep rest unchanged] ...
@app.route('/get_map_points')
def get_map_points():
    cmds = [
        "scoreboard objectives add wp_y dummy",
        "execute as @e[scores={wp_id=-2147483648..}] store result score @s wp_y run data get entity @s Pos[1]",
        "execute as @e[scores={wp_id=-2147483648..}] run scoreboard players get @s wp_id", 
        "execute as @e[scores={wp_x=-2147483648..}] run scoreboard players get @s wp_x", 
        "execute as @e[scores={wp_y=-2147483648..}] run scoreboard players get @s wp_y",
        "execute as @e[scores={wp_z=-2147483648..}] run scoreboard players get @s wp_z"
    ]
    results = execute_batch(cmds)
    if not results: return jsonify({"waypoints": []})
    id_data = parse_rcon_output(results[2])
    x_data = parse_rcon_output(results[3])
    y_data = parse_rcon_output(results[4])
    z_data = parse_rcon_output(results[5])
    waypoints = []
    for entity_uuid, true_id in id_data.items():
        if entity_uuid in x_data and entity_uuid in z_data:
            waypoints.append({ 
                "id": true_id, 
                "x": x_data[entity_uuid], 
                "y": y_data.get(entity_uuid, -29),
                "z": z_data[entity_uuid] 
            })
    return jsonify({"waypoints": waypoints})

@app.route('/send_route', methods=['POST'])
def update_route():
    data = request.json
    try: final = [int(x) for x in data.get('route', "").split(',') if x.strip().isdigit()]
    except: return jsonify({"status": "error"}), 400
    if not final: return jsonify({"status": "error"}), 400
    p_id_str = str(data['plane_tag'])
    if p_id_str in FLIGHT_DB:
        FLIGHT_DB[p_id_str]['active_wp_route'] = final
    sel = f"@e[scores={{plane_id={data['plane_tag']}}},limit=1]"
    execute_batch([f"data merge entity {sel} {{ForgeData:{{Route:{str(final).replace(' ', '')}}}}}", f"execute as {sel} store result score @s current_target run data get entity @s ForgeData.Route[0]"])
    return jsonify({"status": "sent"})

@app.route('/set_status', methods=['POST'])
def set_status():
    d = request.json
    sel = f"@e[scores={{plane_id={d['plane_tag']}}},limit=1]"
    cmds = [f"tag {sel} remove taxiing", f"tag {sel} remove flying"]
    if d['mode'] == 'taxi': cmds.append(f"tag {sel} add taxiing")
    elif d['mode'] == 'fly': cmds.append(f"tag {sel} add flying")
    execute_batch(cmds)
    return jsonify({"status": "updated"})

@app.route('/teleport_plane', methods=['POST'])
def teleport_plane():
    d = request.json
    execute_batch([f"execute as @e[scores={{plane_id={d['plane_tag']}}}] run tp @s @e[type=armor_stand,scores={{wp_id={d['wp_id']}}},limit=1]"])
    return jsonify({"status": "teleported"})

@app.route('/toggle_pause', methods=['POST'])
def toggle_pause():
    global LAST_SIM_STATUS
    LAST_SIM_STATUS = 1 if request.json['paused'] else 0
    execute_batch([f"scoreboard players set #GLOBAL sim_status {LAST_SIM_STATUS}"])
    return jsonify({"status": "ok"})

@app.route('/spawn_plane', methods=['POST'])
def spawn_plane():
    d = request.json
    x, z = d.get('x', 0), d.get('z', 0)
    pt = d.get('type', 'simpleplanes:plane')
    flight_rules = d.get('flight_rules', 'VFR')
    
    new_id = random.randint(1000, 9999)
    if pt == 'FOLLOWME':
        cmd = f'summon automobility:automobile {x} -60 {z} {{frame:"riautomobility:golden_quadmotorcar", engine:"automobility:creative", wheels:"automobility:standard", frontAttachment:{{type:"automobility:empty"}}, rearAttachment:{{type:"automobility:empty", yaw:180.0f}}, Passengers:[{{id:"riautomobility:driver_seat"}}], Tags:["FOLLOWME"]}}'
    elif pt == 'TRUCK':
        cmd = f'summon automobility:automobile {x} -60 {z} {{frame:"riautomobility:lorry", engine:"automobility:creative", wheels:"automobility:carriage", frontAttachment:{{type:"automobility:empty"}}, rearAttachment:{{type:"automobility:empty", yaw:180.0f}}, Passengers:[{{id:"riautomobility:driver_seat"}}], Tags:["TRUCK"]}}'
    else:
        cmd = f"summon {pt} {x} -60 {z}"
        
    cmds = [cmd]
    if pt in ['FOLLOWME', 'TRUCK']:
        # Assign a plane_id score so it shows up on radar immediately
        # We target the most recently spawned entity of this type nearby
        cmds.append(f"scoreboard players set @e[type=automobility:automobile,tag={pt},limit=1,sort=nearest,x={x},y=-60,z={z}] plane_id {new_id}")
        FLIGHT_DB[str(new_id)] = {
            "callsign": pt, "type": "", "route_text": "",
            "squawk": "", "custom_callsign": pt, "gate": "",
            "entity_type": "automobile",
            "category": "ground", "started_up": False,
            "speed": 2,
            "time_tracker": {"takeoff": None, "landing": None, "go_around": None},
            "untracked": False
        }
    else:
        cmds.append(f"scoreboard players set @e[type={pt},limit=1,sort=nearest,x={x},y=-60,z={z}] plane_id {new_id}")
        is_heli = (pt == 'simpleplanes:helicopter')
        fd = generate_flight_data(new_id, is_heli, flight_rules)
        fd["entity_type"] = "aircraft"
        FLIGHT_DB[str(new_id)] = fd
        
    cmds.append("scoreboard objectives add speed dummy")
    cmds.append(f"scoreboard players set @e[scores={{plane_id={new_id}}},limit=1] speed 2")
    results = execute_batch(cmds)
    return jsonify({"status": "spawned", "results": results})

@app.route('/untrack_plane', methods=['POST'])
def untrack_plane():
    d = request.json
    p_id_str = str(d['plane_tag'])
    if p_id_str in FLIGHT_DB:
        FLIGHT_DB[p_id_str]['untracked'] = True
    if p_id_str in TRACKER: del TRACKER[p_id_str]
    if p_id_str in QUARANTINE: del QUARANTINE[p_id_str]
    return jsonify({"status": "untracked"})

@app.route('/kill_plane', methods=['POST'])
def kill_plane():
    d = request.json
    execute_batch([f"kill @e[scores={{plane_id={d['plane_tag']}}}]"])
    p_id_str = str(d['plane_tag'])
    if p_id_str in FLIGHT_DB: del FLIGHT_DB[p_id_str]
    if p_id_str in TRACKER: del TRACKER[p_id_str]
    if p_id_str in QUARANTINE: del QUARANTINE[p_id_str]
    return jsonify({"status": "killed"})

@app.route('/kill_all', methods=['POST'])
def kill_all():
    results = execute_batch(["execute as @e[type=!automobility:automobile,scores={plane_id=-2147483648..}] run scoreboard players get @s plane_id"])
    if results and results[0]:
        for p_id in parse_rcon_output(results[0]).values():
            p_id_str = str(p_id)
            if p_id_str in FLIGHT_DB: del FLIGHT_DB[p_id_str]
            if p_id_str in TRACKER: del TRACKER[p_id_str]
            if p_id_str in QUARANTINE: del QUARANTINE[p_id_str]

    execute_batch(["kill @e[type=!automobility:automobile,scores={plane_id=-2147483648..}]"])
    return jsonify({"status": "killed_all"})

@app.route('/update_plane_data', methods=['POST'])
def update_plane_data():
    d = request.json
    p_id = str(d['plane_id'])
    if p_id in FLIGHT_DB:
        for field in ['gate', 'custom_callsign', 'type', 'squawk', 'category', 'started_up', 'speed', 'route_text', 'sid', 'airways', 'pfl']:
            if field in d:
                FLIGHT_DB[p_id][field] = d[field]
                if field == 'category' and d[field] == 'local':
                    FLIGHT_DB[p_id]['route_text'] = "LOCAL"
                if field == 'speed':
                    sel = f"@e[scores={{plane_id={p_id}}},limit=1]"
                    execute_batch([
                        "scoreboard objectives add speed dummy",
                        f"scoreboard players set {sel} speed {d['speed']}"
                    ])
        return jsonify({"status": "ok"})
    return jsonify({"status": "error"}), 404

@app.route('/update_times', methods=['POST'])
def update_times():
    d = request.json
    p_id = str(d['plane_id'])
    if p_id in FLIGHT_DB:
        if 'time_tracker' not in FLIGHT_DB[p_id]:
            FLIGHT_DB[p_id]['time_tracker'] = {"takeoff": None, "landing": None, "go_around": None}
        for field in ['takeoff', 'landing', 'go_around']:
            if field in d:
                FLIGHT_DB[p_id]['time_tracker'][field] = d[field]
        return jsonify({"status": "ok"})
    return jsonify({"status": "error"}), 404

@app.route('/set_automobile_type', methods=['POST'])
def set_automobile_type():
    d = request.json
    p_id = str(d['plane_id'])
    vehicle_type = d.get('vehicle_type', 'FOLLOWME')  # FOLLOWME or TRUCK
    if p_id in FLIGHT_DB:
        FLIGHT_DB[p_id]['custom_callsign'] = vehicle_type
        FLIGHT_DB[p_id]['callsign'] = vehicle_type
        execute_batch([
            f"tag @e[type=automobility:automobile,scores={{plane_id={p_id}}}] remove FOLLOWME",
            f"tag @e[type=automobility:automobile,scores={{plane_id={p_id}}}] remove TRUCK",
            f"tag @e[type=automobility:automobile,scores={{plane_id={p_id}}}] add {vehicle_type}"
        ])
        return jsonify({"status": "ok"})
    return jsonify({"status": "error"}), 404

@app.route('/set_weather', methods=['POST'])
def set_weather():
    global SERVER_WEATHER
    d = request.json
    weather_type = d.get('type', 'clear')
    SERVER_WEATHER = weather_type
    execute_batch([f"weather {weather_type}"])
    return jsonify({"status": "weather updated"})

@app.route('/update_score', methods=['POST'])
def update_score():
    global STUDENT_SCORE, SCORE_HISTORY
    d = request.json
    action = d.get('action')
    if action == 'reset':
        STUDENT_SCORE = 100
        SCORE_HISTORY = []
    elif action == 'subtract':
        STUDENT_SCORE -= d.get('points', 0)
        SCORE_HISTORY.append({
            "reason": d.get('reason', ''),
            "points": d.get('points', 0),
            "previousScore": d.get('previousScore', 100)
        })
    elif action == 'undo':
        if SCORE_HISTORY:
            last = SCORE_HISTORY.pop()
            STUDENT_SCORE = last['previousScore']
    return jsonify({"status": "ok"})


@app.route('/spawn_waypoint', methods=['POST'])
def spawn_waypoint():
    d = request.json
    x, z = d.get('x', 0), d.get('z', 0)
    y = d.get('y', -60)  # Default to ground level
    wp_id = d.get('wp_id', random.randint(10000, 99999))
    
    cmds = [
        "scoreboard objectives add wp_y dummy",
        f"summon armor_stand {x} {y} {z} {{Tags:[\"waypoint\"],Marker:1b,Invisible:1b,NoGravity:1b,CustomNameVisible:0b,CustomName:'{{\"text\":\"Node\"}}'}}",
        f"scoreboard players set @e[tag=waypoint,limit=1,sort=nearest,x={x},y={y},z={z}] wp_id {wp_id}",
        # Adding wp_x, wp_y, and wp_z so they get parsed properly by the server later
        f"scoreboard players set @e[tag=waypoint,limit=1,sort=nearest,x={x},y={y},z={z}] wp_x {x}",
        f"scoreboard players set @e[tag=waypoint,limit=1,sort=nearest,x={x},y={y},z={z}] wp_y {y}",
        f"scoreboard players set @e[tag=waypoint,limit=1,sort=nearest,x={x},y={y},z={z}] wp_z {z}"
    ]
    execute_batch(cmds)
    return jsonify({"status": "spawned", "wp_id": wp_id})

@app.route('/delete_waypoint', methods=['POST'])
def delete_waypoint():
    d = request.json
    wp_id = d.get('wp_id')
    cmds = [f"kill @e[type=armor_stand,tag=waypoint,scores={{wp_id={wp_id}}}]"]
    execute_batch(cmds)
    return jsonify({"status": "deleted", "wp_id": wp_id})

@app.route('/trigger_crash', methods=['POST'])
def trigger_crash():
    global LAST_SIM_STATUS
    d = request.json
    x, z = d.get('x', 0), d.get('z', 0)
    
    LAST_SIM_STATUS = 1
    execute_batch(["scoreboard players set #GLOBAL sim_status 1"])
    
    def run_crash_fireworks():
        # Phase 1: Skid sound for 1 second
        cmd_skid = f'playsound automobility:entity.automobile.skid master @a {x} -60 {z} 5.0'
        execute_batch([cmd_skid])
        time.sleep(1.0)
        
        # Phase 2: Explosions and Fireworks for 4 seconds
        cmd_boom_snd = f'playsound minecraft:entity.generic.explode master @a {x} -60 {z} 5.0'
        cmd_boom_prt = f'particle minecraft:explosion_emitter {x} -60 {z} 1 1 1 0 1 force'
        execute_batch([cmd_boom_snd, cmd_boom_prt])
        
        end_time = time.time() + 4
        colors = ["16711680,16755200", "16755200,16776960", "16711680,16776960"]
        while time.time() < end_time:
            c1 = random.choice(colors)
            c2 = random.choice(colors)
            ox, oz = random.uniform(-1.5, 1.5), random.uniform(-1.5, 1.5)
            
            # Type 1 = Large Ball for bigger fireworks
            cmd1 = f'summon firework_rocket {x} -60 {z} {{LifeTime:0,FireworksItem:{{id:"minecraft:firework_rocket",Count:1b,tag:{{Fireworks:{{Explosions:[{{Type:1b,Colors:[I;{c1}]}}]}}}}}}}}'
            cmd_extra = f'summon firework_rocket {x+ox} -60 {z+oz} {{LifeTime:0,FireworksItem:{{id:"minecraft:firework_rocket",Count:1b,tag:{{Fireworks:{{Explosions:[{{Type:1b,Colors:[I;{c2}]}}]}}}}}}}}'
            
            # Constant TNT explosion sound and emitter
            cmd_boom_snd = f'playsound minecraft:entity.generic.explode master @a {x+ox} -60 {z+oz} 3.0 {random.uniform(0.7, 1.2)}'
            cmd_boom_prt = f'particle minecraft:explosion_emitter {x+ox} -60 {z+oz} 1 1 1 0 1 force'
            cmd_boom_scatter = f'particle minecraft:explosion {x} -58 {z} 3 2 3 0 10 force'
            
            # Lots of fire
            cmd2 = f'particle minecraft:campfire_cosy_smoke {x} -58 {z} 3 5 3 0.05 150 force'
            cmd3 = f'particle minecraft:flame {x} -58 {z} 4 2 4 0.1 800 force'
            cmd4 = f'particle minecraft:lava {x} -60 {z} 3 1 3 0.1 30 force'
            
            batch = [cmd1, cmd_extra, cmd_boom_snd, cmd_boom_prt, cmd_boom_scatter, cmd2, cmd3, cmd4]

            execute_batch(batch)
            time.sleep(0.15)
            
    threading.Thread(target=run_crash_fireworks, daemon=True).start()
    return jsonify({"status": "crash_started"})

# Sibling directory for BlueMap web assets
BLUE_MAP_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '../server/bluemap/web'))

@app.route('/bluemap')
def serve_bluemap_redirect():
    from flask import redirect
    return redirect('/bluemap/')

@app.route('/bluemap/')
def serve_bluemap_index():
    return send_from_directory(BLUE_MAP_DIR, 'index.html')

@app.route('/bluemap_demo')
def serve_bluemap_demo():
    return """
    <!DOCTYPE html>
    <html>
    <head>
        <title>BlueMap Standalone Demo</title>
        <style>
            html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; background:#030508; }
            iframe { border:none; width:100%; height:100%; }
        </style>
    </head>
    <body>
        <iframe src="/bluemap/"></iframe>
    </body>
    </html>
    """

@app.route('/bluemap/<path:filename>')
def serve_bluemap_files(filename):
    import mimetypes
    filepath = os.path.join(BLUE_MAP_DIR, filename)
    
    # If the file exists directly, serve it
    if os.path.exists(filepath) and not os.path.isdir(filepath):
        return send_from_directory(BLUE_MAP_DIR, filename)
        
    # If the file doesn't exist, check if there is a .gz version
    gz_filename = filename + '.gz'
    gz_filepath = os.path.join(BLUE_MAP_DIR, gz_filename)
    if os.path.exists(gz_filepath):
        response = send_from_directory(BLUE_MAP_DIR, gz_filename)
        response.headers['Content-Encoding'] = 'gzip'
        
        # Determine the MIME type of the original uncompressed file
        mime_type, _ = mimetypes.guess_type(filename)
        if mime_type:
            response.headers['Content-Type'] = mime_type
        elif filename.endswith('.prbm'):
            # BlueMap's custom packed raw binary mesh format
            response.headers['Content-Type'] = 'application/octet-stream'
            
        return response
        
    return "File not found", 404

# --- BlueMap Assets serving for /vr/ page ---
@app.route('/vr/assets/OrbitControls.js')
def serve_orbit_controls():
    return send_from_directory('templates', 'OrbitControls.js')

@app.route('/vr/assets/<path:filename>')
def serve_vr_assets(filename):
    return serve_bluemap_files(f"assets/{filename}")

@app.route('/vr/maps/<path:filename>')
def serve_vr_maps(filename):
    return serve_bluemap_files(f"maps/{filename}")

@app.route('/vr/lang/<path:filename>')
def serve_vr_lang(filename):
    return serve_bluemap_files(f"lang/{filename}")

@app.route('/vr/settings.json')
def serve_vr_settings():
    return serve_bluemap_files('settings.json')

@app.route('/client_log', methods=['POST'])
def client_log():
    data = request.json
    print(f"[CLIENT LOG] [{data.get('type', 'INFO')}] {data.get('message')}")
    import sys
    sys.stdout.flush()
    sys.stderr.flush()
    return jsonify({"status": "ok"})

if __name__ == '__main__':
    import sys
    # use_reloader=False KILLS the 'Restarting with stat' process
    # which is the only way to stop that signal error
    ssl_ctx = 'adhoc' if '--https' in sys.argv else None
    app.run(debug=True, host='0.0.0.0', use_reloader=False, ssl_context=ssl_ctx)