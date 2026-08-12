# ATC Radar & AWOS System

A real-time Air Traffic Control (ATC) Radar and Automated Weather Observing System (AWOS) built with Python (Flask) and Web technologies, integrated with Minecraft server via RCON.

## Features

- **Real-Time Radar Display**: Interactive radar scope rendering tracked aircraft positions and flight data (`index.html`).
- **3D & VR Controls**: Interactive 3D visualization and Virtual Reality view (`vr.html`).
- **AWOS Integration**: Real-time weather parameters including wind direction, speed, gusting, temperature, dew point, QNH, and QFE (`awos.html`, `awos_main.html`).
- **Minecraft Integration**: Connects via `mcrcon` to fetch flight dynamics and entity positions live from the server.
- **Configurable Generator**: Flexible aircraft callsign, flight types (VFR/IFR), and airport mapping (`generator_settings.json`).

## Requirements

- Python 3.8+
- Flask
- `mcrcon`

## Getting Started

1. Install dependencies:
   ```bash
   pip install flask mcrcon
   ```
2. Configure settings in `generator_settings.json` and ensure RCON parameters match your Minecraft server settings in `atc.py`.
3. Launch the radar server:
   - HTTPS Mode: Double-click `start_https.bat` or run:
     ```bash
     python atc.py --https
     ```
   - HTTP Mode:
     ```bash
     python atc.py
     ```
4. Access the web dashboard in your browser:
   - Radar Dashboard: `http://localhost:5000/` or `https://localhost:5000/`
   - AWOS View: `http://localhost:5000/awos`
   - VR View: `http://localhost:5000/vr`

## License

MIT License
