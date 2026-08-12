
        // --- PREVENT BLUEMAP URL/HISTORY HIJACKING ---
        (function() {
            let _bluemap = null;
            Object.defineProperty(window, 'bluemap', {
                get: function() { return _bluemap; },
                set: function(val) {
                    _bluemap = val;
                    if (_bluemap) {
                        console.log("BlueMap instance intercepted!", _bluemap);
                        _bluemap.updatePageAddress = function() {
                            console.log("updatePageAddress call blocked");
                        };
                    }
                },
                configurable: true
            });
        })();

        // --- CALIBRATION DEFAULTS ---
        let chartConfig = { x: -265, z: 72, scale: 1.0, rotation: 180 };
        let staticWaypoints = [];
        let planes = [];
        let selectedPlaneId = null;
        let animatedRoutePoints = {};
        let hoveredObjectName = null;
        let hoveredObjectDistance = null;

        // Virtual Keyboard State
        let isEditingField = false;
        let editFieldName = "";
        let editFieldLabel = "";
        let editValue = "";

        // Three.js Core
        let scene, camera, renderer, controls, dolly;
        let tablePlane, tableGrid, mapMaterial;
        let tableGroup; // Global reference for 3D map attachment
        let mapWrapperGroup; // Global reference for low-res shader coordinate correction
        let planeMeshes = {}; // { plane_id: Group }
        let waypointMeshes = {}; // { wp_id: Mesh }
        let routeLines = {}; // { plane_id: Line }

        // VR Tablet & 3D Control Panel
        let stripBayTablet;
        let vrControlPanel;
        let vrSelectedPlaneRoute = [];
        let isPlottingRoute = false;
        let vrControlPanelTargetScale = 0.0;
        let vrSelectedWaypointId = null;
        let targetDollyPos = null;

        // Left controller radial menu, AWOS tablet, and pause states
        let leftController = null;
        let leftRadialMenuMesh, leftRadialMenuCanvas, leftRadialMenuCtx, leftRadialMenuTexture;
        let leftRadialMenuOpen = false;
        let leftRadialMenuSelectedSegment = -1;
        let leftRadialMenuScreen = 'main'; // 'main', 'spawn_type', 'spawn_rules_small', 'spawn_rules_large'
        let spawningToolActive = null; // 'FOLLOWME', 'TRUCK', 'PLANE_SMALL_VFR', etc.
        let isPaused = false;
        let currentWeatherState = 'clear';
        let awosTablet, awosCanvas, awosCtx, awosTexture;
        let lastAwosHoverX = null, lastAwosHoverY = null;
        let awosHoverX = null, awosHoverY = null;
        let awosData = null;

        // Interaction
        let raycaster, tempMatrix;
        let mouse;
        let controllers = [];
        let hoveredWaypointId = null;
        let hoveredPlaneId = null;
        let desktopDraggingTag = null;
        let panelHoverX = null, panelHoverY = null;
        let tabletHoverX = null, tabletHoverY = null;
        let lastHoveredWaypointId = null;
        let lastPanelHoverX = null, lastPanelHoverY = null;
        let lastTabletHoverX = null, lastTabletHoverY = null;
        let rightController = null;
        let sharedInverseWorldMatrixUniform = null;

        // Caching variables for rendering optimization
        let lastAnimateScale = null;
        let lastAnimateRotation = null;
        let lastAnimateX = null;
        let lastAnimateZ = null;
        let lastLoadedX = null;
        let lastLoadedZ = null;

        // Scale factors to map Minecraft blocks to Three.js meters
        const MC_TO_THREE_SCALE = 0.025; // 1 block = 2.5cm in 3D
        const TABLE_HEIGHT = 0.8; // Table height in meters (standard VR desk height)

        function init() {
            sharedInverseWorldMatrixUniform = { value: new THREE.Matrix4() };
            const container = document.getElementById('canvas-container');

            // 1. Create Scene
            scene = new THREE.Scene();
            scene.background = new THREE.Color(0x020406);
            scene.fog = new THREE.FogExp2(0x020406, 0.005);

            // Ambient dark grid lines for the room
            const gridHelper = new THREE.GridHelper(50, 50, 0x00d2ff, 0x111e2a);
            gridHelper.position.y = 0.01;
            scene.add(gridHelper);

            // 2. Camera setup
            camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
            camera.position.set(0, 2.0, 3.0); // Stand in front of table

            // Wrap camera in Dolly group for VR locomotion
            dolly = new THREE.Group();
            dolly.position.set(0, 0, 0);
            dolly.add(camera);
            scene.add(dolly);

            // 3. Renderer Setup
            renderer = new THREE.WebGLRenderer({ antialias: true });
            renderer.setPixelRatio(window.devicePixelRatio);
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.xr.enabled = true;
            container.appendChild(renderer.domElement);

            // Custom VR Button Setup
            const vrButton = document.getElementById('vr-enter-btn');
            
            if ('xr' in navigator) {
                navigator.xr.isSessionSupported('immersive-vr').then(function (supported) {
                    if (supported) {
                        vrButton.innerText = 'ENTER VR';
                        vrButton.style.display = 'block';
                        
                        vrButton.addEventListener('click', async () => {
                            try {
                                const session = await navigator.xr.requestSession('immersive-vr', {
                                    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
                                });
                                
                                await renderer.xr.setSession(session);
                                vrButton.innerText = 'EXIT VR';
                                
                                session.addEventListener('end', () => {
                                    vrButton.innerText = 'ENTER VR';
                                    vrButton.style.display = 'block';
                                });
                                
                                // Hide button in VR
                                vrButton.style.display = 'none';
                            } catch (e) {
                                console.error("Failed to start VR session", e);
                                alert("Could not enter VR: " + e.message);
                            }
                        });
                    } else {
                        vrButton.innerText = 'VR NOT SUPPORTED';
                        vrButton.style.display = 'block';
                        vrButton.style.opacity = '0.5';
                        vrButton.style.cursor = 'not-allowed';
                    }
                }).catch(e => {
                    vrButton.innerText = 'VR ERROR';
                    vrButton.style.display = 'block';
                });
            } else {
                vrButton.innerText = 'WEBXR NOT SUPPORTED';
                vrButton.style.display = 'block';
                vrButton.style.opacity = '0.5';
                vrButton.style.cursor = 'not-allowed';
            }

            // 4. Lights
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
            scene.add(ambientLight);

            const tableLight = new THREE.DirectionalLight(0x00d2ff, 0.8);
            tableLight.position.set(0, 5, 0);
            scene.add(tableLight);

            // 5. Controls (for desktop fallback)
            controls = new THREE.OrbitControls(camera, renderer.domElement);
            controls.target.set(0, TABLE_HEIGHT, 0);
            controls.enableDamping = true;
            controls.dampingFactor = 0.05;
            controls.maxPolarAngle = Math.PI / 2 - 0.05; // Don't go below floor

            // 6. Raycasting Setup
            raycaster = new THREE.Raycaster();
            tempMatrix = new THREE.Matrix4();
            mouse = new THREE.Vector2();

            // 7. Create Holographic Radar Table
            createRadarTable();

            // Create Strip Bay Tablet Mesh
            stripBayTablet = createStripBayTablet();

            // Create Floating VR Control Panel Mesh
            createVRControlPanelMesh();

            // 8. VR Controllers Setup
            setupVRControllers();

            // 9. Event Listeners
            window.addEventListener('resize', onWindowResize);
            renderer.domElement.addEventListener('pointerdown', onPointerDown);

            // 10. Fetch calibration and map points
            syncMapCalibration();
            syncWaypoints();

            // Start checking for BlueMap initialization
            checkBlueMapInit();

            // 11. Start update cycles
            setInterval(loop, 250);

            // 12. Run render loop
            renderer.setAnimationLoop(animate);

            // Create Left Radial Menu and AWOS Tablet
            leftRadialMenuMesh = createLeftRadialMenuMesh();
            awosTablet = createAwosTablet();
            setInterval(updateAwosData, 1000);

            // Redraw everything once custom web fonts are fully loaded
            if (document.fonts) {
                document.fonts.ready.then(() => {
                    console.log("Fonts loaded, redrawing VR interfaces");
                    if (selectedPlaneId) {
                        const plane = planes.find(p => p.id === selectedPlaneId);
                        if (plane) drawVRControlPanel(plane);
                    }
                    drawStripBay();
                    // Rebuild labels for all existing plane meshes
                    for (let pid in planeMeshes) {
                        const group = planeMeshes[pid];
                        if (group) {
                            const plane = planes.find(p => p.id === pid);
                            if (plane) {
                                const labelText = (plane.custom_callsign || plane.callsign || plane.id) + 
                                                  " | " + (plane.type || "UNK") + 
                                                  " | " + Math.max(0, Math.round((plane.y + 61) * 100)) + "ft";
                                const isSelected = (plane.id === selectedPlaneId);
                                const color = isSelected ? 0x00ff66 : getCategoryColor(plane.category);
                                updateOrCreateTextBillboard(group, labelText, color);
                            }
                        }
                    }
                });
            }
        }

        // --- HOLOGRAPHIC TABLE GENERATION ---
        // --- HOLOGRAPHIC TABLE GENERATION ---
        function createRadarTable() {
            const tableWidth = 4.0;
            const tableLength = 4.0;

            tableGroup = new THREE.Group();
            tableGroup.position.set(0, TABLE_HEIGHT, 0);

            // Keep an invisible tablePlane for click/intersection detection
            const mapGeo = new THREE.PlaneGeometry(tableWidth, tableLength);
            mapMaterial = new THREE.MeshBasicMaterial({ visible: false });
            tablePlane = new THREE.Mesh(mapGeo, mapMaterial);
            tablePlane.rotation.x = -Math.PI / 2; // Flat on table
            tableGroup.add(tablePlane);

            scene.add(tableGroup);
        }

        // --- BLUEMAP INTEGRATION ---
        function checkBlueMapInit() {
            console.log("Waiting for BlueMap to initialize...");
            const checkTimer = setInterval(() => {
                if (window.bluemap && 
                    window.bluemap.mapViewer && 
                    window.bluemap.mapViewer.map && 
                    window.bluemap.mapViewer.map.isLoaded) {
                    clearInterval(checkTimer);
                    integrateBlueMap3D();
                }
            }, 200);
        }

        function modifyLowresMaterial(material) {
            if (material.__modified) return;
            material.__modified = true;

            // Add our custom inverse world matrix uniform
            material.uniforms.uInverseWorldMatrix = sharedInverseWorldMatrixUniform;

            // Modify vertex shader to correct vWorldPosition
            let vs = material.vertexShader;
            if (vs && vs.includes("vWorldPosition = worldPos.xyz;")) {
                vs = "uniform mat4 uInverseWorldMatrix;\n" + vs;
                vs = vs.replace("vWorldPosition = worldPos.xyz;", "vWorldPosition = (uInverseWorldMatrix * worldPos).xyz;");
                material.vertexShader = vs;
                material.needsUpdate = true;
                console.log("Patched lowres shader material for coordinate restoration.");
            }
        }

        function integrateBlueMap3D() {
            console.log("BlueMap WebApp ready. Integrating 3D tiles...");
            const mapViewer = window.bluemap.mapViewer;
            
            // Force 3D free-flight perspective view so hires tiles are loaded
            if (typeof window.bluemap.setFreeFlight === 'function') {
                window.bluemap.setFreeFlight(0);
                console.log("Forced BlueMap free-flight 3D perspective mode.");
            }
            // Restore hires view distance to 300 and lowres to 1500 for full map detail and coverage
            if (mapViewer.data) {
                mapViewer.data.loadedHiresViewDistance = 300;
                mapViewer.data.loadedLowresViewDistance = 1500;
            }
            mapViewer.loadedHiresViewDistance = 300;
            mapViewer.loadedLowresViewDistance = 1500;

            // 1. Lock BlueMap's camera target/controls position close to the runway ground level
            // and set a close zoom distance so hires tiles are loaded.
            if (mapViewer.controlsManager) {
                mapViewer.controlsManager.position.set(chartConfig.x, -40, chartConfig.z); // Close to ground (y = -60)
                mapViewer.controlsManager.distance = 50; // Close distance
                if (typeof mapViewer.controlsManager.updateCamera === 'function') {
                    mapViewer.controlsManager.updateCamera();
                }
                mapViewer.controlsManager.update = function() {
                    // No-op to disable background camera movement/drift that causes half-loaded chunks
                };
                console.log("BlueMap background camera controls locked.");
            }
            
            // Force BlueMap to update and load the area
            mapViewer.loadMapArea(chartConfig.x, chartConfig.z, 300, 1500);
            
            // Pause/bypass BlueMap's internal off-screen WebGL rendering to save massive CPU/GPU resources
            if (mapViewer.renderer) {
                mapViewer.renderer.render = function() {
                    // No-op! Bypasses double rendering overhead in WebXR.
                };
                console.log("BlueMap WebGL renderer bypassed to save performance.");
            }

            // Create a wrapper group for alignment to prevent BlueMap from overwriting translation
            mapWrapperGroup = new THREE.Group();

            // Helper to add scenes to the table wrapper group
            const addSceneIfValid = (sceneGroup, name) => {
                if (sceneGroup) {
                    mapWrapperGroup.add(sceneGroup);
                    console.log(`Successfully added ${name} scene group to table wrapper.`);
                }
            };

            // 1. Add Hires Scene
            const hiresScene = mapViewer.map.hiresTileManager ? mapViewer.map.hiresTileManager.scene : null;
            if (hiresScene) {
                addSceneIfValid(hiresScene, "hires");
                
                // Hook into the scene's add method to monitor tile loadings
                const oldAdd = hiresScene.add;
                hiresScene.add = function(object) {
                    console.log("Tile mesh added to hiresScene:", object.name || object.uuid || "unnamed");
                    return oldAdd.apply(this, arguments);
                };
            } else {
                console.warn("Hires scene not found!");
            }

            // 2. Add Lowres Scene and hook shader modifications
            if (mapViewer.map.lowresTileManager) {
                const managers = Array.isArray(mapViewer.map.lowresTileManager) ? 
                                 mapViewer.map.lowresTileManager : [mapViewer.map.lowresTileManager];
                
                const mainLowresManager = managers[0];
                if (mainLowresManager && mainLowresManager.scene) {
                    addSceneIfValid(mainLowresManager.scene, "lowres[0]");
                }
                
                managers.forEach(manager => {
                    if (manager && manager.scene) {
                        const oldLowresAdd = manager.scene.add;
                        manager.scene.add = function(object) {
                            if (object.isMesh && object.material) {
                                modifyLowresMaterial(object.material);
                            }
                            return oldLowresAdd.apply(this, arguments);
                        };
                        
                        // Apply immediately to already loaded tiles
                        manager.scene.traverse(child => {
                            if (child.isMesh && child.material) {
                                modifyLowresMaterial(child.material);
                            }
                        });
                    }
                });
            }
            
            // Translate the wrapper group so that chartConfig (x, z) is centered at (0, 0)
            // and the ground height (wy = -60) is at y = 0
            mapWrapperGroup.position.set(-chartConfig.x, 60, -chartConfig.z);
            
            // Create the map container group
            const map3DGroup = new THREE.Group();
            map3DGroup.add(mapWrapperGroup);
            map3DGroup.name = "map3DGroup";
            
            // Scale and rotate the map group to match table configurations
            // Negative rotation around Y is used because Three.js Y-rotation is counter-clockwise,
            // which is the opposite of the coordinate projections formula.
            map3DGroup.rotation.y = -(chartConfig.rotation || 0) * Math.PI / 180;
            map3DGroup.scale.setScalar(chartConfig.scale * MC_TO_THREE_SCALE);
            
            // Add to the tableGroup
            if (tableGroup) {
                tableGroup.add(map3DGroup);
                // Hide the flat map texture plane and grid since we have the 3D map
                if (tablePlane) tablePlane.visible = false;
                if (tableGrid) tableGrid.visible = false;
                console.log("3D map successfully added to holographic table!");
 
                // Recurrently log loaded tile count for debugging
                setInterval(() => {
                    try {
                        let logStr = "";
                        if (hiresScene) {
                            logStr += "Hires tiles: " + hiresScene.children.length;
                        }
                        if (mapViewer.map.lowresTileManager) {
                            if (Array.isArray(mapViewer.map.lowresTileManager)) {
                                mapViewer.map.lowresTileManager.forEach((manager, index) => {
                                    if (manager && manager.scene) {
                                        logStr += ` | Lowres[${index}] tiles: ` + manager.scene.children.length;
                                    }
                                });
                            } else if (mapViewer.map.lowresTileManager.scene) {
                                logStr += " | Lowres tiles: " + mapViewer.map.lowresTileManager.scene.children.length;
                            }
                        }
                        console.log(logStr || "No tiles loaded");
                    } catch(e) {
                        console.log("Log interval error:", e.message);
                    }
                }, 2000);
            }
        }

        // --- COORDINATE PROJECTIONS ---
        function worldToTable(wx, wz, wy = -60) {
            // Clamp wy to minimum of -60 so planes/ground entities do not sink below the table surface
            let clampedY = Math.max(-60, wy);

            // Translate relative to calibrated center
            let dx = wx - chartConfig.x;
            let dz = wz - chartConfig.z;

            // Rotate by map calibration rotation
            let rad = (chartConfig.rotation || 0) * Math.PI / 180;
            let rx = dx * Math.cos(rad) - dz * Math.sin(rad);
            let rz = dx * Math.sin(rad) + dz * Math.cos(rad);

            // Apply map scale and map-to-Three.js scene scale
            let scaleFactor = chartConfig.scale * MC_TO_THREE_SCALE;
            let tx = rx * scaleFactor;
            let tz = rz * scaleFactor;

            // Altitude (Y coordinate)
            // Grass is -60 (maps to table surface y = TABLE_HEIGHT)
            // Scale vertically in the exact same proportion as horizontal to match terrain scale
            let ty = TABLE_HEIGHT + (clampedY - (-60)) * scaleFactor;

            return new THREE.Vector3(tx, ty, tz);
        }

        function tableToWorld(tx, tz) {
            let scaleFactor = chartConfig.scale * MC_TO_THREE_SCALE;
            if (scaleFactor === 0) return { x: 0, z: 0 };
            let rx = tx / scaleFactor;
            let rz = tz / scaleFactor;

            let rad = -(chartConfig.rotation || 0) * Math.PI / 180;
            let dx = rx * Math.cos(rad) - rz * Math.sin(rad);
            let dz = rx * Math.sin(rad) + rz * Math.cos(rad);

            let wx = dx + chartConfig.x;
            let wz = dz + chartConfig.z;

            return { x: wx, z: wz };
        }

        // --- WEBGL RESOURCE DISPOSAL HELPERS ---
        function disposeMaterial(mat) {
            if (!mat) return;
            mat.dispose();
            for (const key of Object.keys(mat)) {
                const value = mat[key];
                if (value && typeof value.dispose === 'function') {
                    try { value.dispose(); } catch (e) {}
                }
            }
        }

        function disposeHierarchy(obj) {
            if (!obj) return;
            obj.traverse(child => {
                if (child.isMesh || child.isLine || child.isPoints) {
                    if (child.geometry) {
                        try { child.geometry.dispose(); } catch (e) {}
                    }
                    if (child.material) {
                        if (Array.isArray(child.material)) {
                            child.material.forEach(m => disposeMaterial(m));
                        } else {
                            disposeMaterial(child.material);
                        }
                    }
                }
            });
        }

        // --- VR CONTROLLERS SETUP ---
        function setupVRControllers() {
            // Controller 1
            const controller1 = renderer.xr.getController(0);
            controller1.addEventListener('selectstart', onSelectStart);
            controller1.addEventListener('selectend', onSelectEnd);
            dolly.add(controller1);
            controllers.push(controller1);

            // Controller 2
            const controller2 = renderer.xr.getController(1);
            controller2.addEventListener('selectstart', onSelectStart);
            controller2.addEventListener('selectend', onSelectEnd);
            dolly.add(controller2);
            controllers.push(controller2);

            // Connected event listeners to bind the strip bay tablet to the right hand
            const handleControllerConnect = function (event) {
                const source = event.data;
                
                // Build a futuristic, holographic-themed controller model
                const modelGroup = new THREE.Group();
                modelGroup.name = "controllerModel";
                
                // 1. Grip handle (cylinder)
                const gripGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8);
                const gripMat = new THREE.MeshStandardMaterial({
                    color: 0x111e2a, // dark slate blue
                    roughness: 0.6,
                    metalness: 0.7
                });
                const grip = new THREE.Mesh(gripGeo, gripMat);
                grip.position.set(0, -0.04, 0.02);
                grip.rotation.x = Math.PI / 4;
                modelGroup.add(grip);
                
                // 2. Glowing loop (torus)
                const loopGeo = new THREE.TorusGeometry(0.035, 0.004, 8, 24);
                const loopMat = new THREE.MeshBasicMaterial({
                    color: 0x00d2ff, // neon cyan
                    transparent: true,
                    opacity: 0.8
                });
                const loop = new THREE.Mesh(loopGeo, loopMat);
                loop.position.set(0, 0.005, -0.015);
                loop.rotation.x = Math.PI / 4;
                modelGroup.add(loop);
                
                // 3. Pointer nozzle (cone)
                const nozzleGeo = new THREE.ConeGeometry(0.008, 0.02, 8);
                nozzleGeo.rotateX(Math.PI / 2); // Point forward along Z
                const nozzleMat = new THREE.MeshBasicMaterial({ color: 0x00d2ff });
                const nozzle = new THREE.Mesh(nozzleGeo, nozzleMat);
                nozzle.position.set(0, 0, -0.035);
                modelGroup.add(nozzle);
                
                this.add(modelGroup);

                if (source && source.handedness === 'right') {
                    console.log("Right VR Controller connected. Anchoring Strip Bay Tablet...");
                    rightController = this; // Save reference to right hand controller!
                    if (stripBayTablet) {
                        this.add(stripBayTablet);
                        stripBayTablet.visible = true;
                    }
                }
                if (source && source.handedness === 'left') {
                    console.log("Left VR Controller connected. Anchoring Radial Menu & AWOS Tablet...");
                    leftController = this;
                    if (leftRadialMenuMesh) {
                        this.add(leftRadialMenuMesh);
                    }
                    if (awosTablet) {
                        this.add(awosTablet);
                    }
                }
            };
            controller1.addEventListener('connected', handleControllerConnect);
            controller2.addEventListener('connected', handleControllerConnect);

            // Volumetric glowing pointer ray beams (cylinders)
            const beamGeo = new THREE.CylinderGeometry(0.002, 0.002, 1, 6);
            beamGeo.rotateX(Math.PI / 2); // align with Z axis
            beamGeo.translate(0, 0, -0.5); // shift so start is at (0, 0, 0)
            const beamMat = new THREE.MeshBasicMaterial({
                color: 0x00d2ff,
                transparent: true,
                opacity: 0.45
            });

            const beam = new THREE.Mesh(beamGeo, beamMat);
            beam.name = 'ray';
            beam.scale.z = 10; // Default length 10m

            controller1.add(beam);
            controller2.add(beam.clone());
        }

        function onSelectEnd(e) {
            const controller = e.target;
            if (controller.userData.draggingTag) {
                const dragInfo = controller.userData.draggingTag;
                const duration = Date.now() - (controller.userData.selectStartTime || 0);
                
                // If it was a quick click/tap (held for less than 300ms), open the control panel
                if (duration < 300) {
                    selectPlane(dragInfo.planeId);
                } else {
                    console.log("VR: Dragged tag, did not open control panel. Duration:", duration);
                }
                controller.userData.draggingTag = null;
            }
        }

        // --- VR INTERACTION HELPER FUNCTIONS ---
        function drawRoundRect(ctx, x, y, width, height, radius, fill = false, stroke = true) {
            ctx.beginPath();
            ctx.moveTo(x + radius, y);
            ctx.lineTo(x + width - radius, y);
            ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
            ctx.lineTo(x + width, y + height - radius);
            ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
            ctx.lineTo(x + radius, y + height);
            ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
            ctx.lineTo(x, y + radius);
            ctx.quadraticCurveTo(x, y, x + radius, y);
            ctx.closePath();
            if (fill) ctx.fill();
            if (stroke) ctx.stroke();
        }

        function triggerHapticFeedback(intensity = 0.5, duration = 40) {
            const session = renderer.xr.getSession();
            if (session) {
                for (const source of session.inputSources) {
                    if (source.gamepad && source.gamepad.hapticActuators) {
                        const actuator = source.gamepad.hapticActuators[0];
                        if (actuator) actuator.pulse(intensity, duration);
                    }
                }
            }
        }

        // --- ELECTRONIC STRIP BAY TABLET ---
        let stripBayCanvas, stripBayCtx, stripBayTexture;

        function createStripBayTablet() {
            const group = new THREE.Group();

            stripBayCanvas = document.createElement('canvas');
            stripBayCanvas.width = 1024;
            stripBayCanvas.height = 1024;
            stripBayCtx = stripBayCanvas.getContext('2d');

            stripBayTexture = new THREE.CanvasTexture(stripBayCanvas);
            const clipboardGeo = new THREE.PlaneGeometry(0.3, 0.4);
            const clipboardMat = new THREE.MeshBasicMaterial({
                map: stripBayTexture,
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const clipboardMesh = new THREE.Mesh(clipboardGeo, clipboardMat);
            clipboardMesh.name = "clipboardPage";
            group.add(clipboardMesh);

            // Backing board
            const backGeo = new THREE.PlaneGeometry(0.32, 0.42);
            const backMat = new THREE.MeshPhysicalMaterial({
                color: 0x070b19,
                roughness: 0.1,
                metalness: 0.1,
                transmission: 0.85,
                opacity: 0.35,
                transparent: true,
                depthWrite: false
            });
            const backMesh = new THREE.Mesh(backGeo, backMat);
            backMesh.position.z = -0.005;
            group.add(backMesh);

            // Metal clip at the top
            const clipGeo = new THREE.BoxGeometry(0.1, 0.02, 0.01);
            const clipMat = new THREE.MeshStandardMaterial({
                color: 0x778899,
                roughness: 0.1,
                metalness: 0.9
            });
            const clipMesh = new THREE.Mesh(clipGeo, clipMat);
            clipMesh.position.set(0, 0.19, 0.005);
            group.add(clipMesh);

            group.visible = false;
            group.position.set(0.0, 0.18, -0.12);
            group.rotation.set(-Math.PI / 3, 0, 0);

            return group;
        }

        function drawStripBay(hoverX = null, hoverY = null) {
            if (!stripBayCanvas || !stripBayCtx) return;

            const ctx = stripBayCtx;
            ctx.clearRect(0, 0, stripBayCanvas.width, stripBayCanvas.height);
            ctx.save();
            ctx.scale(2, 2);

            const w = 512;
            const h = 512;

            // Clear and draw background
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, 'rgba(10, 15, 30, 0.35)');
            grad.addColorStop(1, 'rgba(5, 7, 15, 0.45)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            // Draw header
            ctx.fillStyle = '#00d2ff';
            ctx.font = 'bold 24px "IBM Plex Sans", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('ELECTRONIC STRIP BAY', w / 2, 40);

            // Underline header
            ctx.strokeStyle = 'rgba(0, 210, 255, 0.3)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(20, 55);
            ctx.lineTo(w - 20, 55);
            ctx.stroke();

            // List up to 8 planes
            let yOffset = 70;
            const maxStrips = 8;
            const listPlanes = planes.slice(0, maxStrips);

            if (listPlanes.length === 0) {
                ctx.fillStyle = '#667788';
                ctx.font = 'italic 18px "IBM Plex Sans", sans-serif';
                ctx.fillText('NO ACTIVE TRAFFIC', w / 2, h / 2);
            } else {
                listPlanes.forEach((p, idx) => {
                    const isSelected = (p.id === selectedPlaneId);
                    const isHovered = (hoverX !== null && hoverY !== null && hoverX >= 20 && hoverX <= w - 20 && hoverY >= yOffset && hoverY <= yOffset + 46);
                    const color = getCategoryColor(p.category);
                    const colorHexStr = '#' + new THREE.Color(color).getHexString();

                    // Card background
                    ctx.fillStyle = isSelected ? 'rgba(30, 45, 75, 0.6)' : (isHovered ? 'rgba(20, 30, 50, 0.5)' : 'rgba(12, 17, 28, 0.4)');
                    ctx.strokeStyle = isSelected ? '#ffffff' : (isHovered ? '#00d2ff' : colorHexStr);
                    ctx.lineWidth = isSelected ? 3 : (isHovered ? 2.5 : 1.5);

                    drawRoundRect(ctx, 20, yOffset, w - 40, 46, 6, true, true);

                    // Draw callsign
                    ctx.textAlign = 'left';
                    ctx.font = 'bold 18px "IBM Plex Sans", sans-serif';
                    ctx.fillStyle = isSelected ? '#ffffff' : colorHexStr;
                    const callsign = p.custom_callsign || p.callsign || p.id;
                    ctx.fillText(callsign, 35, yOffset + 28);

                    // Draw aircraft type & squawk
                    ctx.textAlign = 'center';
                    ctx.font = '14px "JetBrains Mono", monospace';
                    ctx.fillStyle = '#a0b0c0';
                    const details = (p.type || "UNK") + " | SQ:" + (p.squawk || "1200");
                    ctx.fillText(details, w / 2, yOffset + 28);

                    // Draw altitude & status
                    ctx.textAlign = 'right';
                    ctx.font = 'bold 14px "IBM Plex Sans", sans-serif';
                    const altStr = Math.max(0, Math.round((p.y + 61) * 100)) + "ft";
                    ctx.fillStyle = p.status === 'fly' ? '#00ff66' : (p.status === 'taxi' ? '#ffcc00' : '#8899aa');
                    ctx.fillText(`${altStr} | ${p.status.toUpperCase()}`, w - 35, yOffset + 28);

                    yOffset += 52;
                });
            }

            ctx.restore();
            if (stripBayTexture) stripBayTexture.needsUpdate = true;
        }

        function handleStripBayClick(x, y) {
            console.log("Strip bay clicked at:", x, y);
            if (x < 20 || x > 492) return;
            const maxStrips = 8;
            const listPlanes = planes.slice(0, maxStrips);
            for (let i = 0; i < listPlanes.length; i++) {
                const yStart = 70 + i * 52;
                const yEnd = yStart + 46;
                if (y >= yStart && y <= yEnd) {
                    const plane = listPlanes[i];
                    console.log("Selected plane from strip bay:", plane.id);
                    
                    // Move the user smoothly towards it:
                    const planeGroup = planeMeshes[plane.id];
                    if (planeGroup) {
                        const targetPos = new THREE.Vector3().copy(planeGroup.position);
                        targetPos.z += 0.5; // Offset 0.5m in Z
                        targetPos.y = dolly.position.y; // Keep current height
                        targetDollyPos = targetPos;
                    }
                    
                    selectPlane(plane.id);
                    triggerHapticFeedback(0.6, 50);
                    break;
                }
            }
        }

        // --- INTERACTIVE PLANE CONTROL DASHBOARD ---
        let vrControlPanelCanvas, vrControlPanelCtx, vrControlPanelTexture;

        function createVRControlPanelMesh() {
            const group = new THREE.Group();

            vrControlPanelCanvas = document.createElement('canvas');
            vrControlPanelCanvas.width = 1024;
            vrControlPanelCanvas.height = 1024;
            vrControlPanelCtx = vrControlPanelCanvas.getContext('2d');

            vrControlPanelTexture = new THREE.CanvasTexture(vrControlPanelCanvas);
            const material = new THREE.MeshBasicMaterial({
                map: vrControlPanelTexture,
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false
            });

            const geometry = new THREE.PlaneGeometry(0.45, 0.45);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = "panelPage";
            group.add(mesh);

            // Backing glass board
            const backGeo = new THREE.PlaneGeometry(0.47, 0.47);
            const backMat = new THREE.MeshPhysicalMaterial({
                color: 0x070b19,
                roughness: 0.1,
                metalness: 0.1,
                transmission: 0.85,
                opacity: 0.35,
                transparent: true,
                depthWrite: false
            });
            const backMesh = new THREE.Mesh(backGeo, backMat);
            backMesh.position.z = -0.005;
            group.add(backMesh);

            vrControlPanel = group;
            vrControlPanel.visible = false;
            vrControlPanel.scale.set(0, 0, 0);
            scene.add(vrControlPanel);
        }

        // --- VIRTUAL KEYBOARD HELPERS ---
        function getKeyboardKeyAt(x, y) {
            const startY = 130;
            const rowHeight = 68;
            const keyHeight = 60;
            
            const rowIdx = Math.floor((y - startY) / rowHeight);
            if (rowIdx < 0 || rowIdx > 4) return null;
            
            const yOffsetInRow = (y - startY) % rowHeight;
            if (yOffsetInRow > keyHeight) return null;
            
            if (rowIdx === 0 || rowIdx === 1) {
                const keys = rowIdx === 0 ? 
                    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"] : 
                    ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"];
                const keyWidth = 42;
                const gap = 6;
                const leftOffset = 19;
                const colIdx = Math.floor((x - leftOffset) / (keyWidth + gap));
                if (colIdx >= 0 && colIdx < 10) {
                    const xOffsetInKey = (x - leftOffset) % (keyWidth + gap);
                    if (xOffsetInKey <= keyWidth) {
                        return keys[colIdx];
                    }
                }
            } else if (rowIdx === 2 || rowIdx === 3) {
                const keys = rowIdx === 2 ? 
                    ["A", "S", "D", "F", "G", "H", "J", "K", "L"] : 
                    ["Z", "X", "C", "V", "B", "N", "M", "-", "/"];
                const keyWidth = 42;
                const gap = 6;
                const leftOffset = 43;
                const colIdx = Math.floor((x - leftOffset) / (keyWidth + gap));
                if (colIdx >= 0 && colIdx < 9) {
                    const xOffsetInKey = (x - leftOffset) % (keyWidth + gap);
                    if (xOffsetInKey <= keyWidth) {
                        return keys[colIdx];
                    }
                }
            } else if (rowIdx === 4) {
                const leftOffset = 21;
                const gap = 10;
                const buttonsDef = [
                    { name: "CANCEL", width: 90 },
                    { name: "SPACE", width: 170 },
                    { name: "BACK", width: 90 },
                    { name: "DONE", width: 90 }
                ];
                
                let currentX = leftOffset;
                for (let btn of buttonsDef) {
                    if (x >= currentX && x <= currentX + btn.width) {
                        return btn.name;
                    }
                    currentX += btn.width + gap;
                }
            }
            return null;
        }

        function drawKeyboard(hoverX, hoverY) {
            const ctx = vrControlPanelCtx;
            ctx.clearRect(0, 0, vrControlPanelCanvas.width, vrControlPanelCanvas.height);
            ctx.save();
            ctx.scale(2, 2);

            const w = 512;
            const h = 512;
            
            // Clear background
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, 'rgba(8, 12, 22, 0.35)');
            grad.addColorStop(1, 'rgba(4, 6, 12, 0.45)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
            
            // Outer border
            ctx.strokeStyle = '#00d2ff';
            ctx.lineWidth = 4;
            drawRoundRect(ctx, 4, 4, w - 8, h - 8, 12, false, true);
            
            // Header showing field
            ctx.fillStyle = '#8899aa';
            ctx.font = 'bold 16px "IBM Plex Sans", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(`EDITING ${editFieldLabel}`, w / 2, 35);
            
            // Input display box
            ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
            ctx.strokeStyle = 'rgba(0, 210, 255, 0.3)';
            ctx.lineWidth = 2;
            drawRoundRect(ctx, 20, 55, w - 40, 50, 6, true, true);
            
            // Draw typed text
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 22px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            const cursor = (Math.floor(Date.now() / 500) % 2 === 0) ? "|" : "";
            ctx.fillText(editValue + cursor, 35, 87);
            
            // Highlighted hover key
            const hoveredKey = (hoverX !== null && hoverY !== null) ? getKeyboardKeyAt(hoverX, hoverY) : null;
            
            // Helper to draw a key
            const drawKey = (label, x, y, kw, kh, isActive) => {
                const isHovered = (hoveredKey === label);
                ctx.fillStyle = isActive ? '#00d2ff' : (isHovered ? 'rgba(0, 210, 255, 0.25)' : '#1e293b');
                ctx.strokeStyle = isHovered ? '#00d2ff' : 'rgba(255, 255, 255, 0.1)';
                ctx.lineWidth = 1.5;
                drawRoundRect(ctx, x, y, kw, kh, 5, true, true);
                
                ctx.fillStyle = isActive ? '#030508' : '#ffffff';
                ctx.textAlign = 'center';
                ctx.font = 'bold 16px "IBM Plex Sans", sans-serif';
                ctx.fillText(label, x + kw / 2, y + kh / 2 + 6);
            };

            const startY = 130;
            const rowHeight = 68;
            const keyHeight = 60;

            // Row 0 & 1
            const rows01 = [
                ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
                ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"]
            ];
            rows01.forEach((keys, rIdx) => {
                const leftOffset = 19;
                const keyWidth = 42;
                const gap = 6;
                keys.forEach((k, colIdx) => {
                    const x = leftOffset + colIdx * (keyWidth + gap);
                    const y = startY + rIdx * rowHeight;
                    drawKey(k, x, y, keyWidth, keyHeight, false);
                });
            });

            // Row 2 & 3
            const rows23 = [
                ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
                ["Z", "X", "C", "V", "B", "N", "M", "-", "/"]
            ];
            rows23.forEach((keys, rIdx) => {
                const actualRowIdx = rIdx + 2;
                const leftOffset = 43;
                const keyWidth = 42;
                const gap = 6;
                keys.forEach((k, colIdx) => {
                    const x = leftOffset + colIdx * (keyWidth + gap);
                    const y = startY + actualRowIdx * rowHeight;
                    drawKey(k, x, y, keyWidth, keyHeight, false);
                });
            });

            // Row 4 (Func keys)
            const leftOffset = 21;
            const gap = 10;
            const buttonsDef = [
                { name: "CANCEL", width: 90, color: '#ff3366' },
                { name: "SPACE", width: 170, color: '#334155' },
                { name: "BACK", width: 90, color: '#eab308' },
                { name: "DONE", width: 90, color: '#00ff66' }
            ];
            let currentX = leftOffset;
            buttonsDef.forEach(btn => {
                const y = startY + 4 * rowHeight;
                const isHovered = (hoveredKey === btn.name);
                ctx.fillStyle = isHovered ? 'rgba(0, 210, 255, 0.35)' : btn.color;
                ctx.strokeStyle = isHovered ? '#00d2ff' : 'rgba(255, 255, 255, 0.1)';
                ctx.lineWidth = 1.5;
                drawRoundRect(ctx, currentX, y, btn.width, keyHeight, 5, true, true);
                
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.font = 'bold 14px "IBM Plex Sans", sans-serif';
                ctx.fillText(btn.name, currentX + btn.width / 2, y + keyHeight / 2 + 5);
                
                currentX += btn.width + gap;
            });

            ctx.restore();
            if (vrControlPanelTexture) vrControlPanelTexture.needsUpdate = true;
        }

        function openKeyboard(fieldName, fieldLabel, initialValue) {
            console.log("Opening virtual keyboard for field: " + fieldName + ", initial: " + initialValue);
            isEditingField = true;
            editFieldName = fieldName;
            editFieldLabel = fieldLabel;
            editValue = String(initialValue);
            drawKeyboard(null, null);
        }

        async function handleKeyboardClick(x, y) {
            const key = getKeyboardKeyAt(x, y);
            if (!key) return;
            
            triggerHapticFeedback(0.5, 40);
            
            if (key === "CANCEL") {
                console.log("Keyboard: CANCEL clicked");
                isEditingField = false;
                const plane = planes.find(p => p.id === selectedPlaneId);
                if (plane) drawVRControlPanel(plane);
            } else if (key === "DONE") {
                console.log("Keyboard: DONE clicked. Field: " + editFieldName + ", Value: " + editValue);
                isEditingField = false;
                
                const planeId = selectedPlaneId;
                const plane = planes.find(p => p.id === planeId);
                if (plane) {
                    plane[editFieldName] = editValue;
                    if (editFieldName === 'route_text') {
                        plane.route = editValue;
                    }
                    
                    // Send update to server
                    await fetch('/update_plane_data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_id: planeId, [editFieldName]: editValue })
                    });
                    
                    drawVRControlPanel(plane);
                }
            } else if (key === "BACK") {
                if (editValue.length > 0) {
                    editValue = editValue.slice(0, -1);
                }
                drawKeyboard(x, y);
            } else if (key === "SPACE") {
                editValue += " ";
                drawKeyboard(x, y);
            } else {
                editValue += key;
                drawKeyboard(x, y);
            }
        }

        function drawVRControlPanel(plane, hoverX = null, hoverY = null) {
            if (!vrControlPanelCanvas || !vrControlPanelCtx) return;

            if (isEditingField) {
                drawKeyboard(hoverX, hoverY);
                return;
            }

            const ctx = vrControlPanelCtx;
            ctx.clearRect(0, 0, vrControlPanelCanvas.width, vrControlPanelCanvas.height);
            ctx.save();
            ctx.scale(2, 2);

            const w = 512;
            const h = 512;

            // Helper to draw a button (defined at top to be used inside panel drawing)
            const drawButton = (label, x, y, bw, bh, active, activeColor = '#00d2ff', inactiveColor = 'rgba(30, 41, 59, 0.4)') => {
                const isHovered = (hoverX !== null && hoverY !== null && hoverX >= x && hoverX <= x + bw && hoverY >= y && hoverY <= y + bh);
                
                ctx.fillStyle = active ? activeColor : (isHovered ? 'rgba(0, 210, 255, 0.25)' : inactiveColor);
                ctx.strokeStyle = active ? '#ffffff' : (isHovered ? '#00d2ff' : 'rgba(255, 255, 255, 0.1)');
                ctx.lineWidth = isHovered ? 2.5 : 1.5;
                drawRoundRect(ctx, x, y, bw, bh, 5, true, true);
                
                // Draw a subtle outer glow if hovered
                if (isHovered) {
                    ctx.save();
                    ctx.shadowColor = '#00d2ff';
                    ctx.shadowBlur = 8;
                    ctx.strokeStyle = '#00d2ff';
                    ctx.lineWidth = 1.0;
                    drawRoundRect(ctx, x - 2, y - 2, bw + 4, bh + 4, 7, false, true);
                    ctx.restore();
                }
                
                ctx.fillStyle = active ? '#030508' : '#ffffff';
                ctx.textAlign = 'center';
                ctx.font = 'bold 13px "IBM Plex Sans", sans-serif';
                ctx.fillText(label, x + bw / 2, y + bh / 2 + 5);
            };

            // Helper to draw a text box (defined at top to be used inside panel drawing)
            const drawTextBox = (label, value, x, y, bw, bh) => {
                const isHovered = (hoverX !== null && hoverY !== null && hoverX >= x && hoverX <= x + bw && hoverY >= y && hoverY <= y + bh);
                
                ctx.fillStyle = isHovered ? 'rgba(30, 41, 59, 0.6)' : 'rgba(15, 23, 42, 0.35)';
                ctx.strokeStyle = isHovered ? '#00d2ff' : 'rgba(255, 255, 255, 0.2)';
                ctx.lineWidth = isHovered ? 2 : 1;
                drawRoundRect(ctx, x, y, bw, bh, 4, true, true);
                
                ctx.fillStyle = '#8899aa';
                ctx.font = 'bold 8px "IBM Plex Sans", sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText(label, x + 6, y + 10);
                
                ctx.fillStyle = '#ffffff';
                let fontSize = 11;
                ctx.font = `bold ${fontSize}px "JetBrains Mono", monospace`;
                
                const valStr = value || '--';
                let textWidth = ctx.measureText(valStr).width;
                const maxValWidth = bw - 12;
                while (textWidth > maxValWidth && fontSize > 7) {
                    fontSize -= 1;
                    ctx.font = `bold ${fontSize}px "JetBrains Mono", monospace`;
                    textWidth = ctx.measureText(valStr).width;
                }
                ctx.fillText(valStr, x + 6, y + 23);
            };

            // Clear background
            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, 'rgba(8, 12, 22, 0.35)');
            grad.addColorStop(1, 'rgba(4, 6, 12, 0.45)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            // Draw glowing boundary based on plane category
            const catColor = getCategoryColor(plane.category);
            const catColorHex = '#' + new THREE.Color(catColor).getHexString();
            ctx.strokeStyle = catColorHex;
            ctx.lineWidth = 4;
            drawRoundRect(ctx, 4, 4, w - 8, h - 8, 12, false, true);

            // Header (Y: 10 to 65)
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.font = 'bold 26px "IBM Plex Sans", sans-serif';
            const title = plane.custom_callsign || plane.callsign || plane.id;
            ctx.fillText(title, w / 2, 32);

            ctx.font = '14px "JetBrains Mono", monospace';
            ctx.fillStyle = '#8899aa';
            ctx.fillText(`${plane.type || "UNKNOWN TYPE"} | SQ: ${plane.squawk || "STANDBY"}`, w / 2, 56);

            // Separator 1
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(20, 66);
            ctx.lineTo(w - 20, 66);
            ctx.stroke();

            // Info (Y: 70 to 110)
            ctx.font = 'bold 13px "IBM Plex Sans", sans-serif';
            ctx.fillStyle = '#a0b0c0';
            ctx.textAlign = 'left';
            ctx.fillText("ALTITUDE:", 30, 92);

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 13px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            const altText = Math.max(0, Math.round((plane.y + 61) * 100)) + " ft";
            ctx.fillText(altText, 110, 92);

            // Route Editable TextBox
            drawTextBox("ROUTE", plane.route, 250, 72, 242, 32);

            // Separator 2
            ctx.beginPath();
            ctx.moveTo(20, 110);
            ctx.lineTo(w - 20, 110);
            ctx.stroke();

            // Category & Engine (Y: 115 to 147)
            const cat = plane.category ? plane.category.toLowerCase() : '';
            drawButton("ARR", 20, 115, 70, 32, cat === 'arrival', '#00ff66');
            drawButton("DEP", 95, 115, 70, 32, cat === 'departure', '#ff3366');
            drawButton("LOC", 170, 115, 70, 32, cat === 'local', '#00d2ff');
            drawButton("GND", 245, 115, 70, 32, cat === 'ground', '#ffcc00');
            
            const engLabel = plane.started_up ? "ENG: STARTED" : "ENG: OFF";
            drawButton(engLabel, 325, 115, 167, 32, plane.started_up, '#00ff66', '#334155');

            // Status (Y: 155 to 187)
            drawButton("IDLE", 20, 155, 150, 32, plane.status === 'idle', '#a0b0c0');
            drawButton("TAXI", 181, 155, 150, 32, plane.status === 'taxi', '#ffcc00');
            drawButton("FLY", 342, 155, 150, 32, plane.status === 'fly', '#00ff66');

            // Speed (Y: 195 to 225)
            const spd = plane.speed || 2;
            drawButton("SLOW", 20, 195, 110, 30, spd === 1, '#5cadff');
            drawButton("NORM", 136, 195, 110, 30, spd === 2, '#5cadff');
            drawButton("FAST", 252, 195, 110, 30, spd === 3, '#5cadff');
            drawButton("MAX", 368, 195, 124, 30, spd === 4, '#5cadff');

            // Textbox Row 1 (Callsign, Type, Squawk, Gate) (Y: 230 to 260)
            drawTextBox("CALLSIGN", plane.custom_callsign || plane.callsign || plane.id, 20, 230, 110, 30);
            drawTextBox("TYPE", plane.type, 140, 230, 110, 30);
            drawTextBox("SQUAWK", plane.squawk, 260, 230, 110, 30);
            drawTextBox("GATE", plane.gate, 380, 230, 110, 30);

            // Textbox Row 2 (PFL, SID, Airways) (Y: 265 to 295)
            drawTextBox("PLANNED FL", plane.pfl, 20, 265, 150, 30);
            drawTextBox("SID DEPARTURE", plane.sid, 181, 265, 150, 30);
            drawTextBox("AIRWAYS ROUTE", plane.airways, 342, 265, 150, 30);

            // Route builder display (Y: 305 to 335)
            ctx.fillStyle = 'rgba(30, 41, 59, 0.5)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
            drawRoundRect(ctx, 20, 305, w - 40, 30, 4, true, true);

            ctx.fillStyle = '#ffcc00';
            ctx.font = '12px "JetBrains Mono", monospace';
            ctx.textAlign = 'left';
            const routeBuildStr = vrSelectedPlaneRoute.length > 0 ? vrSelectedPlaneRoute.join(' → ') : "NO WAYPOINTS IN ROUTE";
            ctx.fillText(routeBuildStr, 32, 324);

            // Route Actions (Y: 342 to 372)
            drawButton("TELEPORT TO LAST", 20, 342, 226, 30, vrSelectedPlaneRoute.length > 0, '#ffaa00', 'rgba(30, 41, 59, 0.3)');
            drawButton("CLEAR ROUTE", 266, 342, 226, 30, false, '#ff5555', '#334155');

            // System actions (Y: 382 to 417)
            drawButton("UNTRACK AIRCRAFT", 20, 382, 226, 35, false, '#ffaa00', '#c2410c');
            drawButton("TERMINATE / KILL", 266, 382, 226, 35, false, '#ef4444', '#991b1b');

            ctx.restore();
            if (vrControlPanelTexture) vrControlPanelTexture.needsUpdate = true;
        }

        function openVRControlPanel(plane) {
            const group = planeMeshes[plane.id];
            if (group) {
                const label = group.getObjectByName("label");
                if (label) {
                    label.visible = true;
                    const labelText = (plane.custom_callsign || plane.callsign || plane.id) + 
                                      " | " + (plane.type || "UNK") + 
                                      " | " + Math.max(0, Math.round((plane.y + 61) * 100)) + "ft";
                    updateOrCreateTextBillboard(group, labelText, 0x00ff66);
                }
            }

            vrSelectedPlaneRoute = [];
            isPlottingRoute = true;
            drawVRControlPanel(plane);
            
            if (rightController) {
                rightController.add(vrControlPanel);
                vrControlPanel.position.set(0.0, 0.18, -0.12);
                vrControlPanel.rotation.set(-Math.PI / 3, 0, 0);
                vrControlPanel.scale.setScalar(0.8);
                vrControlPanel.visible = true;
                
                if (stripBayTablet) {
                    stripBayTablet.visible = false;
                }
            } else {
                scene.add(vrControlPanel);
                vrControlPanelTargetScale = 0.8;
                vrControlPanel.visible = true;
            }
        }

        function closeVRControlPanel() {
            isEditingField = false;
            if (selectedPlaneId) {
                const group = planeMeshes[selectedPlaneId];
                if (group) {
                    const label = group.getObjectByName("label");
                    if (label) {
                        label.visible = true;
                        const plane = planes.find(p => p.id === selectedPlaneId);
                        if (plane) {
                            const labelText = (plane.custom_callsign || plane.callsign || plane.id) + 
                                              " | " + (plane.type || "UNK") + 
                                              " | " + Math.max(0, Math.round((plane.y + 61) * 100)) + "ft";
                            updateOrCreateTextBillboard(group, labelText, getCategoryColor(plane.category));
                        }
                    }
                }
            }

            selectedPlaneId = null;
            vrControlPanelTargetScale = 0.0;
            
            if (rightController) {
                rightController.remove(vrControlPanel);
                if (stripBayTablet) {
                    stripBayTablet.visible = true;
                }
            }
            scene.add(vrControlPanel);
            vrControlPanel.visible = false;
            vrControlPanel.scale.set(0, 0, 0);
        }

        async function handleVRControlPanelClick(x, y) {
            if (isEditingField) {
                await handleKeyboardClick(x, y);
                return;
            }
            if (!selectedPlaneId) return;
            const planeId = selectedPlaneId;
            const plane = planes.find(p => p.id === planeId);
            if (!plane) return;

            triggerHapticFeedback(0.6, 50);

            // 0. Route textbox (Y: 72 to 104)
            if (y >= 72 && y <= 104) {
                if (x >= 250 && x <= 492) {
                    openKeyboard('route_text', 'ROUTE / AIRPORT', plane.route || "");
                    return;
                }
            }

            // 1. Category & Engine (Y: 115 to 147)
            if (y >= 115 && y <= 147) {
                if (x >= 20 && x <= 90) {
                    console.log("VR: Set ARR category");
                    plane.category = 'arrival';
                    await fetch('/update_plane_data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_id: planeId, category: 'arrival' })
                    });
                } else if (x >= 95 && x <= 165) {
                    console.log("VR: Set DEP category");
                    plane.category = 'departure';
                    await fetch('/update_plane_data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_id: planeId, category: 'departure' })
                    });
                } else if (x >= 170 && x <= 240) {
                    console.log("VR: Set LOC category");
                    plane.category = 'local';
                    await fetch('/update_plane_data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_id: planeId, category: 'local' })
                    });
                } else if (x >= 245 && x <= 315) {
                    console.log("VR: Set GND category");
                    plane.category = 'ground';
                    await fetch('/update_plane_data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_id: planeId, category: 'ground' })
                    });
                } else if (x >= 325 && x <= 492) {
                    const nextState = !plane.started_up;
                    console.log("VR: Toggle Engine to " + nextState);
                    plane.started_up = nextState;
                    await fetch('/update_plane_data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_id: planeId, started_up: nextState })
                    });
                }
                drawVRControlPanel(plane);
            }

            // 2. Status (Y: 155 to 187) - Auto-sends route on TAXI or FLY
            if (y >= 155 && y <= 187) {
                let targetMode = '';
                if (x >= 20 && x <= 170) targetMode = 'idle';
                else if (x >= 181 && x <= 331) targetMode = 'taxi';
                else if (x >= 342 && x <= 492) targetMode = 'fly';

                if (targetMode) {
                    // Auto-send route if taxi or fly is clicked and there are waypoints
                    if ((targetMode === 'taxi' || targetMode === 'fly') && vrSelectedPlaneRoute.length > 0) {
                        console.log("VR: Auto-sending route before status update:", vrSelectedPlaneRoute);
                        await fetch('/send_route', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ plane_tag: planeId, route: vrSelectedPlaneRoute.join(', ') })
                        });
                        vrSelectedPlaneRoute = []; // Clear plotting route visually
                        isPlottingRoute = true; // keep plotting state to display empty route!
                    }
                    console.log("VR: Set status " + targetMode);
                    plane.status = targetMode;
                    await fetch('/set_status', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_tag: planeId, mode: targetMode })
                    });
                    drawVRControlPanel(plane);
                }
            }

            // 3. Speed (Y: 195 to 225)
            if (y >= 195 && y <= 225) {
                let targetSpeed = 0;
                if (x >= 20 && x <= 130) targetSpeed = 1;
                else if (x >= 136 && x <= 246) targetSpeed = 2;
                else if (x >= 252 && x <= 362) targetSpeed = 3;
                else if (x >= 368 && x <= 492) targetSpeed = 4;

                if (targetSpeed > 0) {
                    console.log("VR: Set speed " + targetSpeed);
                    plane.speed = targetSpeed;
                    await fetch('/update_plane_data', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_id: planeId, speed: targetSpeed })
                    });
                    drawVRControlPanel(plane);
                }
            }

            // 4. Textbox Row 1 (Callsign, Type, Squawk, Gate) (Y: 230 to 260)
            if (y >= 230 && y <= 260) {
                if (x >= 20 && x <= 130) {
                    openKeyboard('custom_callsign', 'CALLSIGN', plane.custom_callsign || plane.callsign || plane.id);
                } else if (x >= 140 && x <= 250) {
                    openKeyboard('type', 'AIRCRAFT TYPE', plane.type || "");
                } else if (x >= 260 && x <= 370) {
                    openKeyboard('squawk', 'SQUAWK CODE', plane.squawk || "");
                } else if (x >= 380 && x <= 490) {
                    openKeyboard('gate', 'GATE ASSIGNMENT', plane.gate || "");
                }
            }

            // 5. Textbox Row 2 (PFL, SID, Airways) (Y: 265 to 295)
            if (y >= 265 && y <= 295) {
                if (x >= 20 && x <= 170) {
                    openKeyboard('pfl', 'PLANNED FLIGHT LEVEL', plane.pfl || "");
                } else if (x >= 181 && x <= 331) {
                    openKeyboard('sid', 'SID DEPARTURE', plane.sid || "");
                } else if (x >= 342 && x <= 492) {
                    openKeyboard('airways', 'AIRWAYS ROUTE', plane.airways || "");
                }
            }

            // 6. Route Actions (Y: 342 to 372) - Teleport to Last / Clear Route
            if (y >= 342 && y <= 372) {
                if (x >= 20 && x <= 246) {
                    if (vrSelectedPlaneRoute.length > 0) {
                        const targetID = vrSelectedPlaneRoute[vrSelectedPlaneRoute.length - 1];
                        console.log("VR: Teleport plane to last waypoint: " + targetID);
                        await fetch('/teleport_plane', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ plane_tag: planeId, wp_id: targetID })
                        });
                    }
                } else if (x >= 266 && x <= 492) {
                    console.log("VR: Clear route");
                    vrSelectedPlaneRoute = [];
                    isPlottingRoute = true; // flag plotting state!
                }
                drawVRControlPanel(plane);
            }

            // 7. System Actions (Y: 382 to 417)
            if (y >= 382 && y <= 417) {
                if (x >= 20 && x <= 246) {
                    console.log("VR: Untrack plane " + planeId);
                    await fetch('/untrack_plane', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_tag: planeId })
                    });
                    closeVRControlPanel();
                } else if (x >= 266 && x <= 492) {
                    console.log("VR: Kill plane " + planeId);
                    await fetch('/kill_plane', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ plane_tag: planeId })
                    });
                    closeVRControlPanel();
                }
            }
        }

        function getActiveCameraWorldPosition() {
            const pos = new THREE.Vector3();
            if (renderer && renderer.xr && renderer.xr.isPresenting) {
                const xrCamera = renderer.xr.getCamera(camera);
                xrCamera.getWorldPosition(pos);
            } else {
                camera.getWorldPosition(pos);
            }
            return pos;
        }

        // --- TEXTURE BILLBOARDS (Live 3D Labels - Reused & Optimized) ---
        function updateOrCreateTextBillboard(group, text, colorHex = 0x00d2ff) {
            let label = group ? group.getObjectByName("label") : null;
            
            if (label && label.userData && label.userData.isBillboard) {
                // Check if anything actually changed
                if (label.userData.text === text && label.userData.colorHex === colorHex) {
                    return label; // Reuse completely without redraw
                }
                
                // Update canvas content on the existing texture
                const canvas = label.userData.canvas;
                const ctx = canvas.getContext('2d');
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                
                const colorStr = '#' + new THREE.Color(colorHex).getHexString();
                const pad = 8;
                const radius = 24;

                // Background fill — solid dark with high opacity for contrast
                ctx.fillStyle = 'rgba(8, 12, 22, 0.92)';
                ctx.strokeStyle = colorStr;
                ctx.lineWidth = 6;
                ctx.beginPath();
                if (typeof ctx.roundRect === 'function') {
                    ctx.roundRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2, radius);
                } else {
                    const x = pad, y = pad, w = canvas.width - pad * 2, h = canvas.height - pad * 2, r = radius;
                    ctx.moveTo(x + r, y);
                    ctx.lineTo(x + w - r, y);
                    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
                    ctx.lineTo(x + w, y + h - r);
                    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
                    ctx.lineTo(x + r, y + h);
                    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
                    ctx.lineTo(x, y + r);
                    ctx.quadraticCurveTo(x, y, x + r, y);
                }
                ctx.fill();
                ctx.stroke();

                // Subtle inner accent line at top
                ctx.save();
                ctx.globalAlpha = 0.35;
                ctx.fillStyle = colorStr;
                ctx.beginPath();
                if (typeof ctx.roundRect === 'function') {
                    ctx.roundRect(pad + 3, pad + 3, canvas.width - (pad + 3) * 2, 5, [4, 4, 0, 0]);
                } else {
                    ctx.fillRect(pad + radius, pad + 3, canvas.width - (pad + radius) * 2, 5);
                }
                ctx.fill();
                ctx.restore();

                // Label text — large, bold, with thick outline for maximum readability
                let fontSize = 80;
                ctx.font = `bold ${fontSize}px "IBM Plex Sans", "Segoe UI", Arial, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                // Auto-shrink if text overflows
                let textWidth = ctx.measureText(text).width;
                const maxWidth = canvas.width - 80;
                while (textWidth > maxWidth && fontSize > 32) {
                    fontSize -= 4;
                    ctx.font = `bold ${fontSize}px "IBM Plex Sans", "Segoe UI", Arial, sans-serif`;
                    textWidth = ctx.measureText(text).width;
                }

                const cx = canvas.width / 2;
                const cy = canvas.height / 2 + 4; // slight vertical nudge for visual centering

                // Dark outline for contrast against any background
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
                ctx.lineWidth = 8;
                ctx.lineJoin = 'round';
                ctx.strokeText(text, cx, cy);

                // Colored glow layer
                ctx.shadowColor = colorStr;
                ctx.shadowBlur = 12;
                ctx.fillStyle = '#ffffff';
                ctx.fillText(text, cx, cy);
                ctx.shadowBlur = 0;
                
                label.userData.text = text;
                label.userData.colorHex = colorHex;
                label.userData.texture.needsUpdate = true;
                label.renderOrder = 100;
                
                return label;
            }
            
            // If it doesn't exist, create it
            const canvas = document.createElement('canvas');
            canvas.width = 1024;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');

            const colorStr = '#' + new THREE.Color(colorHex).getHexString();
            const pad = 8;
            const radius = 24;

            // Background fill — solid dark with high opacity for contrast
            ctx.fillStyle = 'rgba(8, 12, 22, 0.92)';
            ctx.strokeStyle = colorStr;
            ctx.lineWidth = 6;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(pad, pad, canvas.width - pad * 2, canvas.height - pad * 2, radius);
            } else {
                const x = pad, y = pad, w = canvas.width - pad * 2, h = canvas.height - pad * 2, r = radius;
                ctx.moveTo(x + r, y);
                ctx.lineTo(x + w - r, y);
                ctx.quadraticCurveTo(x + w, y, x + w, y + r);
                ctx.lineTo(x + w, y + h - r);
                ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
                ctx.lineTo(x + r, y + h);
                ctx.quadraticCurveTo(x, y + h, x, y + h - r);
                ctx.lineTo(x, y + r);
                ctx.quadraticCurveTo(x, y, x + r, y);
            }
            ctx.fill();
            ctx.stroke();

            // Subtle inner accent line at top
            ctx.save();
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = colorStr;
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(pad + 3, pad + 3, canvas.width - (pad + 3) * 2, 5, [4, 4, 0, 0]);
            } else {
                ctx.fillRect(pad + radius, pad + 3, canvas.width - (pad + radius) * 2, 5);
            }
            ctx.fill();
            ctx.restore();

            // Label text — large, bold, with thick outline for maximum readability
            let fontSize = 80;
            ctx.font = `bold ${fontSize}px "IBM Plex Sans", "Segoe UI", Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // Auto-shrink if text overflows
            let textWidth = ctx.measureText(text).width;
            const maxWidth = canvas.width - 80;
            while (textWidth > maxWidth && fontSize > 32) {
                fontSize -= 4;
                ctx.font = `bold ${fontSize}px "IBM Plex Sans", "Segoe UI", Arial, sans-serif`;
                textWidth = ctx.measureText(text).width;
            }

            const cx = canvas.width / 2;
            const cy = canvas.height / 2 + 4; // slight vertical nudge for visual centering

            // Dark outline for contrast against any background
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
            ctx.lineWidth = 8;
            ctx.lineJoin = 'round';
            ctx.strokeText(text, cx, cy);

            // Colored glow layer
            ctx.shadowColor = colorStr;
            ctx.shadowBlur = 12;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, cx, cy);
            ctx.shadowBlur = 0;

            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = true;
            texture.anisotropy = 16;

            const material = new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                side: THREE.DoubleSide,
                depthTest: true,
                depthWrite: false
            });

            // Larger geometry — 4:1 aspect ratio matching the canvas
            const geometry = new THREE.PlaneGeometry(0.48, 0.12);
            const mesh = new THREE.Mesh(geometry, material);
            mesh.renderOrder = 100;
            
            mesh.name = "label";
            mesh.userData = {
                isBillboard: true,
                canvas: canvas,
                texture: texture,
                text: text,
                colorHex: colorHex
            };
            
            return mesh;
        }

        // --- DATA RETRIEVAL & POLLING ---
        async function syncMapCalibration() {
            try {
                const r = await fetch('/get_generator_settings');
                const data = await r.json();
                if (data.map_x !== undefined) chartConfig.x = data.map_x;
                if (data.map_z !== undefined) chartConfig.z = data.map_z;
                if (data.map_scale !== undefined) chartConfig.scale = data.map_scale;
                if (data.map_rotation !== undefined) chartConfig.rotation = data.map_rotation;
            } catch (e) {
                console.error("Could not sync calibration settings", e);
            }
        }

        async function syncWaypoints() {
            try {
                const r = await fetch('/get_map_points');
                const data = await r.json();
                staticWaypoints = data.waypoints;

                // Clear old meshes
                Object.values(waypointMeshes).forEach(m => scene.remove(m));
                waypointMeshes = {};

                // Render waypoints in 3D
                staticWaypoints.forEach(wp => {
                    const pos = worldToTable(wp.x, wp.z, wp.y);

                    const isGround = (wp.y <= -50);
                    const wpColor = isGround ? 0xffaa00 : 0x00d2ff;

                    let geo;
                    if (isGround) {
                        geo = new THREE.SphereGeometry(0.03, 16, 16);
                    } else {
                        // Diamond shape for airborne waypoints to make them clearly visible
                        geo = new THREE.OctahedronGeometry(0.08);
                    }

                    const mat = new THREE.MeshBasicMaterial({
                        color: wpColor,
                        transparent: true,
                        opacity: 0.85
                    });
                    const mesh = new THREE.Mesh(geo, mat);
                    mesh.position.copy(pos);
                    mesh.scale.setScalar(chartConfig.scale); // Scale waypoint based on map calibration
                    mesh.name = "waypoint_" + wp.id;
                    mesh.userData = { id: wp.id, type: 'waypoint', isGround: isGround, originalY: wp.y };

                    // Inner core glow
                    const coreGeo = isGround ? new THREE.SphereGeometry(0.01, 8, 8) : new THREE.OctahedronGeometry(0.025);
                    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
                    const core = new THREE.Mesh(coreGeo, coreMat);
                    mesh.add(core);

                    // Add a dashed drop line for airborne waypoints
                    if (!isGround) {
                        const lineGeo = new THREE.BufferGeometry().setFromPoints([
                            new THREE.Vector3(0, 0, 0),
                            new THREE.Vector3(0, -100, 0) // Will be updated dynamically by snapWaypointsToTerrain
                        ]);
                        const lineMat = new THREE.LineDashedMaterial({
                            color: wpColor,
                            dashSize: 0.03,
                            gapSize: 0.03,
                            transparent: true,
                            opacity: 0.45
                        });
                        const dropLine = new THREE.Line(lineGeo, lineMat);
                        dropLine.name = "dropline";
                        mesh.add(dropLine);
                    }

                    scene.add(mesh);
                    waypointMeshes[wp.id] = mesh;
                });

                // Immediately snap to whatever terrain is currently loaded
                snapWaypointsToTerrain();
            } catch (e) {
                console.error("Could not sync waypoints", e);
            }
        }

        function snapWaypointsToTerrain() {
            if (!window.bluemap || !window.bluemap.mapViewer || !window.bluemap.mapViewer.map) return;
            const hiresScene = window.bluemap.mapViewer.map.hiresTileManager ? window.bluemap.mapViewer.map.hiresTileManager.scene : null;
            if (!hiresScene) return;

            if (!window.sharedRaycaster) {
                window.sharedRaycaster = new THREE.Raycaster();
            }
            const ray = window.sharedRaycaster;

            staticWaypoints.forEach(wp => {
                if (wp.snapped) return; // Skip if already snapped to terrain!

                const mesh = waypointMeshes[wp.id];
                if (!mesh) return;

                const isGround = (wp.y <= -50);
                
                // Raycast straight down from the waypoint's horizontal position
                const startPos = new THREE.Vector3(mesh.position.x, TABLE_HEIGHT + 2.0, mesh.position.z);
                ray.set(startPos, new THREE.Vector3(0, -1, 0));

                // Raycast ONLY against the high-resolution detailed terrain scene to avoid floating lowres overlaps!
                const intersects = ray.intersectObject(hiresScene, true);
                let terrainY = TABLE_HEIGHT; // Fallback to table height
                let hitTerrain = false;
                if (intersects.length > 0) {
                    terrainY = intersects[0].point.y;
                    hitTerrain = true;
                }

                if (isGround) {
                    // Place ground waypoints exactly on the terrain surface, offset slightly so they don't clip
                    mesh.position.y = terrainY + 0.03 * chartConfig.scale;
                } else {
                    // Update drop line for airborne waypoints
                    const dropLine = mesh.getObjectByName("dropline");
                    if (dropLine) {
                        const localY = -(mesh.position.y - terrainY) / chartConfig.scale;
                        
                        // Update geometry vertices
                        const positions = [
                            0, 0, 0,
                            0, localY, 0
                        ];
                        dropLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                        dropLine.geometry.attributes.position.needsUpdate = true;
                        dropLine.computeLineDistances(); // Re-calculate dashes
                    }
                }

                if (hitTerrain) {
                    wp.snapped = true;
                }
            });
        }

        async function loop() {
            // Keep BlueMap camera centered on airport coordinates so chunks load (throttled to every 3 seconds to save CPU)
            if (window.bluemap && window.bluemap.mapViewer) {
                const mapViewer = window.bluemap.mapViewer;
                const now = Date.now();
                if (!window.lastMapLoadTime || now - window.lastMapLoadTime > 3000 || chartConfig.x !== lastLoadedX || chartConfig.z !== lastLoadedZ) {
                    if (mapViewer.controlsManager) {
                        mapViewer.controlsManager.position.set(chartConfig.x, -40, chartConfig.z);
                        mapViewer.controlsManager.distance = 50;
                    }
                    if (mapViewer.loadMapArea) {
                        mapViewer.loadMapArea(chartConfig.x, chartConfig.z, 300, 1500);
                    }
                    lastLoadedX = chartConfig.x;
                    lastLoadedZ = chartConfig.z;
                    window.lastMapLoadTime = now;
                }
            }

            // Snap waypoints to terrain and update drop lines dynamically as chunks load
            snapWaypointsToTerrain();

            try {
                const r = await fetch('/get_radar');
                const data = await r.json();
                isPaused = data.sim_paused || false;
                currentWeatherState = data.weather || 'clear';
                document.getElementById('connection-status').innerText = `RCON Connected | ${data.planes.length} plane(s) active`;
                
                // Track active plane IDs to purge deleted planes
                const activeIDs = new Set(data.planes.map(p => p.id));

                // Process active planes
                data.planes.forEach(serverPlane => {
                    let localPos = worldToTable(serverPlane.x, serverPlane.z, serverPlane.y);
                    let existing = planes.find(p => p.id === serverPlane.id);

                    if (existing) {
                        // Invalidate cached targetVector if RCON target coordinates changed
                        if (existing.targetX !== serverPlane.x || existing.targetY !== serverPlane.y || existing.targetZ !== serverPlane.z) {
                            existing.targetVector = null;
                        }
                        // Update local cache parameters
                        existing.targetX = serverPlane.x;
                        existing.targetY = serverPlane.y;
                        existing.targetZ = serverPlane.z;
                        existing.heading = serverPlane.heading;
                        existing.status = serverPlane.status;
                        existing.callsign = serverPlane.callsign;
                        existing.custom_callsign = serverPlane.custom_callsign;
                        existing.type = serverPlane.type;
                        existing.squawk = serverPlane.squawk;
                        existing.entity_type = serverPlane.entity_type;
                        existing.active_wp_route = serverPlane.active_wp_route;

                        // Update label billboard content (optimized cache-reusing update)
                        const group = planeMeshes[serverPlane.id];
                        if (group) {
                            const labelText = (serverPlane.custom_callsign || serverPlane.callsign || serverPlane.id) + 
                                              " | " + (serverPlane.type || "UNK") + 
                                              " | " + Math.max(0, Math.round((serverPlane.y + 61) * 100)) + "ft";
                            const isSelected = (serverPlane.id === selectedPlaneId);
                            const color = isSelected ? 0x00ff66 : getCategoryColor(serverPlane.category);
                            const label = updateOrCreateTextBillboard(group, labelText, color);
                            if (!group.getObjectByName("label")) {
                                label.position.set(0, 0.15 * chartConfig.scale, 0);
                                label.visible = true;
                                group.add(label);
                            } else {
                                label.visible = true;
                            }
                        }

                        // Live dashboard updates on the VR floating panel
                        if (serverPlane.id === selectedPlaneId) {
                            drawVRControlPanel(serverPlane);
                        }
                    } else {
                        // Create new plane cache
                        serverPlane.currentX = serverPlane.x;
                        serverPlane.currentY = serverPlane.y;
                        serverPlane.currentZ = serverPlane.z;
                        serverPlane.targetX = serverPlane.x;
                        serverPlane.targetY = serverPlane.y;
                        serverPlane.targetZ = serverPlane.z;
                        serverPlane.targetVector = null;
                        planes.push(serverPlane);

                        // Instantiate 3D model
                        createPlaneMesh(serverPlane);
                    }

                    // Render active routes in 3D
                    drawRouteLine(serverPlane);
                });

                // Clean up deleted planes (proper recursive disposal)
                for (let pid in planeMeshes) {
                    if (!activeIDs.has(pid)) {
                        const group = planeMeshes[pid];
                        scene.remove(group);
                        disposeHierarchy(group);
                        delete planeMeshes[pid];
                        if (routeLines[pid]) {
                            const oldLine = routeLines[pid];
                            scene.remove(oldLine);
                            disposeHierarchy(oldLine);
                            delete routeLines[pid];
                        }
                    }
                }
                planes = planes.filter(p => activeIDs.has(p.id));

                // Sort planes by category priority (DEP, ARR, LOC, GND)
                const categoryPriority = {
                    'departure': 1,
                    'arrival': 2,
                    'local': 3,
                    'ground': 4
                };
                planes.sort((a, b) => {
                    const priorityA = categoryPriority[a.category ? a.category.toLowerCase() : ''] || 99;
                    const priorityB = categoryPriority[b.category ? b.category.toLowerCase() : ''] || 99;
                    if (priorityA !== priorityB) {
                        return priorityA - priorityB;
                    }
                    const nameA = (a.custom_callsign || a.callsign || a.id || '').toString().toLowerCase();
                    const nameB = (b.custom_callsign || b.callsign || b.id || '').toString().toLowerCase();
                    return nameA.localeCompare(nameB);
                });

                // Draw active strips on the tablet
                drawStripBay();

                // If selected plane got deleted, clear panel
                if (selectedPlaneId && !activeIDs.has(selectedPlaneId)) {
                    selectedPlaneId = null;
                    document.getElementById('selection-hud').classList.remove('active');
                } else if (selectedPlaneId) {
                    // Update details overlay
                    const sel = planes.find(p => p.id === selectedPlaneId);
                    if (sel) {
                        updateHUDDetails(sel);
                        if (!isPlottingRoute) {
                            vrSelectedPlaneRoute = [...(sel.active_wp_route || [])];
                        }
                    }
                }

            } catch (e) {
                document.getElementById('connection-status').innerText = "RCON link interrupted, retrying...";
                console.error("Fetch loop error", e);
            }
        }

        // --- 3D MESH GENERATION ---
        function createPlaneMesh(plane) {
            const group = new THREE.Group();
            const pos = worldToTable(plane.currentX, plane.currentZ, plane.currentY);
            group.position.copy(pos);
            group.name = "plane_" + plane.id;

            const isGroundVeh = (plane.entity_type === 'automobile');
            const color = getCategoryColor(plane.category);

            // Sub-group for visual body elements to scale them together without scaling the HUD label text
            const visualGroup = new THREE.Group();
            visualGroup.name = "body";
            group.add(visualGroup);

            let mainMesh;

            if (isGroundVeh) {
                // Ground vehicle (box-car shape)
                const geo = new THREE.BoxGeometry(0.06, 0.04, 0.08);
                const mat = new THREE.MeshStandardMaterial({
                    color: color,
                    emissive: color,
                    emissiveIntensity: 0.2,
                    roughness: 0.3,
                    metalness: 0.5
                });
                mainMesh = new THREE.Mesh(geo, mat);
                visualGroup.add(mainMesh);

                // Small yellow lightbar on top
                const barGeo = new THREE.BoxGeometry(0.04, 0.01, 0.015);
                const barMat = new THREE.MeshStandardMaterial({
                    color: 0xffaa00,
                    emissive: 0xffaa00,
                    emissiveIntensity: 0.8
                });
                const bar = new THREE.Mesh(barGeo, barMat);
                bar.position.y = 0.022;
                visualGroup.add(bar);

                // Glowing outline border tracing the ground vehicle
                const outlineGeo = geo.clone();
                const outlineMat = new THREE.MeshBasicMaterial({
                    color: color,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.65,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                });
                const outlineMesh = new THREE.Mesh(outlineGeo, outlineMat);
                outlineMesh.scale.set(1.15, 1.25, 1.15); // Scale slightly larger
                visualGroup.add(outlineMesh);
            } else {
                // Aircraft shape (sleek high-tech arrow glider)
                const geo = new THREE.ConeGeometry(0.04, 0.12, 3);
                geo.rotateX(Math.PI / 2); // Point forward along Z
                const mat = new THREE.MeshStandardMaterial({
                    color: color,
                    emissive: color,
                    emissiveIntensity: 0.2,
                    roughness: 0.2,
                    metalness: 0.7
                });
                mainMesh = new THREE.Mesh(geo, mat);
                visualGroup.add(mainMesh);

                // Glowing outline border tracing the aircraft
                const outlineGeo = geo.clone();
                const outlineMat = new THREE.MeshBasicMaterial({
                    color: color,
                    wireframe: true,
                    transparent: true,
                    opacity: 0.65,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false
                });
                const outlineMesh = new THREE.Mesh(outlineGeo, outlineMat);
                outlineMesh.scale.set(1.2, 1.1, 1.2); // Scale slightly wider/taller to outline the cone
                visualGroup.add(outlineMesh);

                // Mini wings
                const wingsGeo = new THREE.BoxGeometry(0.16, 0.005, 0.03);
                const wings = new THREE.Mesh(wingsGeo, mat);
                wings.position.set(0, 0, -0.01);
                visualGroup.add(wings);

                // Glowing outline border tracing the wings
                const wingsOutlineGeo = wingsGeo.clone();
                const wingsOutlineMesh = new THREE.Mesh(wingsOutlineGeo, outlineMat);
                wingsOutlineMesh.position.set(0, 0, -0.01);
                wingsOutlineMesh.scale.set(1.1, 2.5, 1.2); // Scale wider/taller
                visualGroup.add(wingsOutlineMesh);
            }

            // Set visual model scale based on map calibration scale
            visualGroup.scale.setScalar(chartConfig.scale);

            // Create billboard label (optimized updateOrCreate)
            const labelText = (plane.custom_callsign || plane.callsign || plane.id) + 
                              " | " + (plane.type || "UNK") + 
                              " | " + Math.max(0, Math.round((plane.y + 61) * 100)) + "ft";
            const labelColor = (plane.id === selectedPlaneId) ? 0x00ff66 : color;
            const label = updateOrCreateTextBillboard(group, labelText, labelColor);
            label.name = "label";
            label.position.set(0, 0.15 * chartConfig.scale, 0); // Hover offset
            label.visible = true;
            group.add(label);

            // Add a larger invisible selection collider to make selection easy
            const selectionGeo = new THREE.SphereGeometry(0.12, 8, 8);
            const selectionMat = new THREE.MeshBasicMaterial({
                transparent: true,
                opacity: 0.0,
                depthWrite: false
            });
            const selectionMesh = new THREE.Mesh(selectionGeo, selectionMat);
            selectionMesh.name = "selection_collider";
            group.add(selectionMesh);

            // Create a line connecting the label to the aircraft center
            const lineGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                label.position
            ]);
            const lineMat = new THREE.LineBasicMaterial({
                color: color,
                transparent: true,
                opacity: 0.5
            });
            const tagLine = new THREE.Line(lineGeo, lineMat);
            tagLine.name = "tagLine";
            tagLine.visible = label.visible;
            tagLine.userData = {
                lastLabelX: label.position.x,
                lastLabelY: label.position.y,
                lastLabelZ: label.position.z
            };
            group.add(tagLine);

            scene.add(group);
            planeMeshes[plane.id] = group;
        }

        // Draw glowing 3D route paths (smooth animated progressive growth & transitions)
        function drawRouteLine(plane) {
            const isSelected = (plane.id === selectedPlaneId);
            
            // If selected, show the plotting route if there is one; otherwise, show the active server route.
            const activeRoute = (isSelected && vrSelectedPlaneRoute.length > 0) ? vrSelectedPlaneRoute : (plane.active_wp_route || []);
            const routeStr = activeRoute.join(',');

            // Determine if route changed or is new
            let startPoint;
            let routeChanged = false;
            let animState = animatedRoutePoints[plane.id];
            if (animState && animState.lastRouteStr === routeStr && animState.startPoint) {
                startPoint = animState.startPoint;
            } else {
                startPoint = worldToTable(plane.currentX, plane.currentZ, plane.currentY);
                routeChanged = true;
            }

            // 1. Determine target points for the route line
            const targetPoints = [];
            targetPoints.push(startPoint.clone());
            
            activeRoute.forEach(wpid => {
                const wp = staticWaypoints.find(x => String(x.id) === String(wpid));
                if (wp) {
                    targetPoints.push(worldToTable(wp.x, wp.z, wp.y));
                }
            });

            // If this is the selected plane, also extend the line to the currently hovered waypoint (if any)
            if (isSelected && hoveredWaypointId) {
                if (activeRoute.length === 0 || String(activeRoute[activeRoute.length - 1]) !== String(hoveredWaypointId)) {
                    const wp = staticWaypoints.find(x => String(x.id) === String(hoveredWaypointId));
                    if (wp) {
                        targetPoints.push(worldToTable(wp.x, wp.z, wp.y));
                    }
                }
            }

            // If there's no points or just the starting point, clean up the line
            if (targetPoints.length <= 1) {
                if (routeLines[plane.id]) {
                    const oldLine = routeLines[plane.id];
                    scene.remove(oldLine);
                    disposeHierarchy(oldLine);
                    delete routeLines[plane.id];
                }
                delete animatedRoutePoints[plane.id];
                return;
            }

            // 2. Initialize or look up the animation state for this plane
            if (!animatedRoutePoints[plane.id]) {
                const categoryColor = getCategoryColor(plane.category);
                animatedRoutePoints[plane.id] = {
                    points: [targetPoints[0].clone()],
                    dashSize: 10.0,
                    gapSize: 0.0,
                    color: new THREE.Color(categoryColor),
                    opacity: 0.65,
                    startPoint: startPoint.clone(),
                    lastRouteStr: routeStr
                };
            } else if (routeChanged) {
                animatedRoutePoints[plane.id].startPoint = startPoint.clone();
                animatedRoutePoints[plane.id].lastRouteStr = routeStr;
                animatedRoutePoints[plane.id].points = [startPoint.clone()];
            }

            animState = animatedRoutePoints[plane.id];
            const currentPoints = animState.points;

            // 3. Adjust currentPoints array to match targetPoints length (progressive growth)
            while (currentPoints.length < targetPoints.length) {
                const lastPt = currentPoints[currentPoints.length - 1] || targetPoints[0];
                currentPoints.push(lastPt.clone());
            }
            if (currentPoints.length > targetPoints.length) {
                currentPoints.length = targetPoints.length;
            }

            // 4. Interpolate all points toward their targets
            for (let i = 0; i < currentPoints.length; i++) {
                if (i === 0) {
                    currentPoints[i].copy(targetPoints[0]); // Plane position updates instantly
                } else {
                    currentPoints[i].lerp(targetPoints[i], 0.15); // Progressive growth interpolation
                }
            }

            // 5. Determine target material properties
            let targetColorVal = getCategoryColor(plane.category);
            let targetDashSize = 10.0;
            let targetGapSize = 0.0;
            let targetOpacity = 0.65;

            const isPlotting = (isSelected && vrSelectedPlaneRoute.length > 0);
            if (isPlotting) {
                targetColorVal = 0x00ff66; // Vibrant green for active plotting route
                targetDashSize = 0.05;
                targetGapSize = 0.03;
                targetOpacity = 0.8;
            }

            const targetColor = new THREE.Color(targetColorVal);

            // Interpolate material properties smoothly
            animState.color.lerp(targetColor, 0.1);
            animState.dashSize += (targetDashSize - animState.dashSize) * 0.1;
            animState.gapSize += (targetGapSize - animState.gapSize) * 0.1;
            animState.opacity += (targetOpacity - animState.opacity) * 0.1;

            // 6. Create or update the Three.js Line object
            let line = routeLines[plane.id];
            if (!line) {
                const geometry = new THREE.BufferGeometry();
                const material = new THREE.LineDashedMaterial({
                    color: animState.color,
                    dashSize: animState.dashSize,
                    gapSize: animState.gapSize,
                    transparent: true,
                    opacity: animState.opacity
                });
                line = new THREE.Line(geometry, material);
                scene.add(line);
                routeLines[plane.id] = line;
            }

            // Update geometry positions dynamically without allocating new Float32Arrays every frame
            const attribute = line.geometry.getAttribute('position');
            if (attribute && attribute.count === currentPoints.length) {
                const array = attribute.array;
                for (let i = 0; i < currentPoints.length; i++) {
                    array[i * 3] = currentPoints[i].x;
                    array[i * 3 + 1] = currentPoints[i].y;
                    array[i * 3 + 2] = currentPoints[i].z;
                }
                attribute.needsUpdate = true;
            } else {
                const positions = [];
                currentPoints.forEach(pt => {
                    positions.push(pt.x, pt.y, pt.z);
                });
                line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            }

            // Sync material attributes
            line.material.color.copy(animState.color);
            line.material.dashSize = animState.dashSize;
            line.material.gapSize = animState.gapSize;
            line.material.opacity = animState.opacity;

            // Flow animation for dashed plotting route
            if (line.material.dashSize < 1.0) {
                line.material.dashOffset = (line.material.dashOffset || 0) - 0.0015;
                line.computeLineDistances(); // Only compute for dashed lines!
            } else {
                line.material.dashOffset = 0;
            }
        }

        // Color coding by category
        function getCategoryColor(cat) {
            if (cat === 'arrival') return 0xffcc00;
            if (cat === 'departure') return 0x00d2ff;
            if (cat === 'local') return 0xffffff;
            if (cat === 'ground') return 0x778899;
            return 0x888888;
        }

        // --- INTERACTION & CLICK HANDLERS ---
        function onPointerDown(e) {
            // Calculate screen coordinates
            mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

            raycaster.setFromCamera(mouse, camera);

            // Check intersection with VR control panel first
            if (vrControlPanel && vrControlPanel.visible) {
                const panelPage = vrControlPanel.getObjectByName("panelPage");
                if (panelPage) {
                    const intersectsPanel = raycaster.intersectObject(panelPage);
                    if (intersectsPanel.length > 0) {
                        const uv = intersectsPanel[0].uv;
                        const x = uv.x * 512;
                        const y = (1 - uv.y) * 512;
                        handleVRControlPanelClick(x, y);
                        return;
                    }
                }
            }

            // Check intersection with waypoints
            const wpMeshes = Object.values(waypointMeshes);
            const intersectsWp = raycaster.intersectObjects(wpMeshes, false); // recursive = false
            if (intersectsWp.length > 0) {
                const wpMesh = intersectsWp[0].object;
                const wpId = wpMesh.userData.id;
                console.log("Pointer clicked waypoint:", wpId);
                vrSelectedWaypointId = wpId;
                if (selectedPlaneId) {
                    isPlottingRoute = true;
                    vrSelectedPlaneRoute.push(wpId);
                    const selectedPlane = planes.find(p => p.id === selectedPlaneId);
                    if (selectedPlane) drawVRControlPanel(selectedPlane);
                }
                return;
            }

            // Intersect with aircraft selection colliders and labels (non-recursive!)
            const planeTargets = [];
            Object.values(planeMeshes).forEach(group => {
                const collider = group.getObjectByName("selection_collider");
                if (collider) planeTargets.push(collider);
                const label = group.getObjectByName("label");
                if (label && label.visible) planeTargets.push(label);
            });
            const intersects = raycaster.intersectObjects(planeTargets, false); // recursive = false

            if (intersects.length > 0) {
                const hitObj = intersects[0].object;
                const planeGroup = hitObj.parent;
                if (planeGroup && planeGroup.name.startsWith("plane_")) {
                    const pid = planeGroup.name.replace("plane_", "");
                    
                    if (hitObj.name === "label") {
                        // Desktop drag detection!
                        desktopDraggingTag = {
                            planeId: pid,
                            distance: intersects[0].distance,
                            planeGroup: planeGroup,
                            labelMesh: hitObj,
                            startTime: Date.now(),
                            startMousePos: new THREE.Vector2(e.clientX, e.clientY)
                        };
                        if (controls) controls.enabled = false; // Disable OrbitControls
                        
                        window.addEventListener('pointermove', onPointerMove);
                        window.addEventListener('pointerup', onPointerUp);
                    } else {
                        selectPlane(pid);
                    }
                }
            }
        }

        function onPointerMove(e) {
            if (!desktopDraggingTag) return;
            mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
            mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            
            const ray = raycaster.ray;
            const targetWorldPos = new THREE.Vector3().copy(ray.origin).addScaledVector(ray.direction, desktopDraggingTag.distance);
            const localPos = desktopDraggingTag.planeGroup.worldToLocal(targetWorldPos);
            
            // Constrain to stay above the plane
            localPos.y = Math.max(0.05 * chartConfig.scale, localPos.y);
            
            desktopDraggingTag.labelMesh.position.copy(localPos);
            
            // Mark tag as dragged so it doesn't reset position on animate loop
            desktopDraggingTag.labelMesh.userData.hasBeenDragged = true;
        }

        function onPointerUp(e) {
            if (desktopDraggingTag) {
                if (controls) controls.enabled = true; // Re-enable OrbitControls
                
                // If it was a quick click/tap without much movement, select the plane
                const duration = Date.now() - desktopDraggingTag.startTime;
                const distMoved = desktopDraggingTag.startMousePos.distanceTo(new THREE.Vector2(e.clientX, e.clientY));
                if (duration < 250 && distMoved < 5) {
                    selectPlane(desktopDraggingTag.planeId);
                }
                
                desktopDraggingTag = null;
            }
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        }

        function onSelectStart(e) {
            const controller = e.target;

            // 0. Left Radial Menu trigger confirm
            if (controller === leftController && leftRadialMenuOpen) {
                if (leftRadialMenuSelectedSegment !== -1) {
                    executeLeftRadialAction(leftRadialMenuSelectedSegment);
                }
                return;
            }

            // 0b. Spawning tool active: trigger spawn on table click
            if (controller === leftController && spawningToolActive) {
                if (tablePlane) {
                    const tempRaycaster = new THREE.Raycaster();
                    const tempMatrix = new THREE.Matrix4();
                    tempMatrix.identity().extractRotation(leftController.matrixWorld);
                    const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
                    const rayOrigin = new THREE.Vector3().setFromMatrixPosition(leftController.matrixWorld);

                    tempRaycaster.ray.origin.copy(rayOrigin);
                    tempRaycaster.ray.direction.copy(rayDirection);

                    const intersects = tempRaycaster.intersectObject(tablePlane);
                    if (intersects.length > 0) {
                        const hitPoint = intersects[0].point;
                        const mcCoords = tableToWorld(hitPoint.x, hitPoint.z);
                        
                        let type = 'simpleplanes:plane';
                        let flightRules = 'VFR';
                        if (spawningToolActive === 'FOLLOWME' || spawningToolActive === 'TRUCK') {
                            type = spawningToolActive;
                        } else if (spawningToolActive === 'PLANE_SMALL_VFR') {
                            type = 'simpleplanes:plane';
                            flightRules = 'VFR';
                        } else if (spawningToolActive === 'PLANE_SMALL_IFR') {
                            type = 'simpleplanes:plane';
                            flightRules = 'IFR';
                        } else if (spawningToolActive === 'PLANE_LARGE_VFR') {
                            type = 'simpleplanes:large_plane';
                            flightRules = 'VFR';
                        } else if (spawningToolActive === 'PLANE_LARGE_IFR') {
                            type = 'simpleplanes:large_plane';
                            flightRules = 'IFR';
                        }

                        fetch('/spawn_plane', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                x: Math.round(mcCoords.x),
                                z: Math.round(mcCoords.z),
                                type: type,
                                flight_rules: flightRules
                            })
                        })
                        .then(r => r.json())
                        .then(() => triggerHapticFeedback(0.7, 80))
                        .catch(err => console.error("Error spawning:", err));
                    }
                }
                return;
            }

            // 0c. AWOS Tablet click handler
            if (awosTablet && awosTablet.visible && awosHoverX !== null && awosHoverY !== null) {
                handleAwosClick(awosHoverX, awosHoverY);
                return;
            }
            
            // 1. Check intersection with VR clipboard tablet (via hover cache)
            if (stripBayTablet && stripBayTablet.visible && tabletHoverX !== null && tabletHoverY !== null) {
                handleStripBayClick(tabletHoverX, tabletHoverY);
                return;
            }

            // 2. Check intersection with VR control panel (via hover cache)
            if (vrControlPanel && vrControlPanel.visible && panelHoverX !== null && panelHoverY !== null) {
                handleVRControlPanelClick(panelHoverX, panelHoverY);
                return;
            }

            // 3. Check intersection with waypoints (via hover cache)
            if (hoveredWaypointId) {
                const wpId = hoveredWaypointId;
                console.log("VR clicked waypoint (via hover cache):", wpId);
                vrSelectedWaypointId = wpId;
                
                if (selectedPlaneId) {
                    isPlottingRoute = true;
                    vrSelectedPlaneRoute.push(wpId);
                    const selectedPlane = planes.find(p => p.id === selectedPlaneId);
                    if (selectedPlane) drawVRControlPanel(selectedPlane);
                }
                
                triggerHapticFeedback(0.5, 40);
                return;
            }

            // 4. Check intersection with planes (via hover cache)
            if (hoveredPlaneId) {
                const pid = hoveredPlaneId;
                if (hoveredObjectName === "label") {
                    // Start dragging the label
                    controller.userData.selectStartTime = Date.now();
                    controller.userData.draggingTag = {
                        planeId: pid,
                        distance: hoveredObjectDistance !== null ? hoveredObjectDistance : 0.15
                    };
                    triggerHapticFeedback(0.4, 30);
                } else {
                    // Click aircraft body
                    selectPlane(pid);
                    triggerHapticFeedback(0.8, 100);
                }
                return;
            }

            // 5. Clicked empty space: do nothing (deselection via thumbstick click only)
        }

        function selectPlane(id) {
            // Restore previous selected plane's label if it exists
            if (selectedPlaneId && selectedPlaneId !== id) {
                const prevGroup = planeMeshes[selectedPlaneId];
                if (prevGroup) {
                    const label = prevGroup.getObjectByName("label");
                    if (label) {
                        label.visible = true;
                        const prevPlane = planes.find(p => p.id === selectedPlaneId);
                        if (prevPlane) {
                            const labelText = (prevPlane.custom_callsign || prevPlane.callsign || prevPlane.id) + 
                                              " | " + (prevPlane.type || "UNK") + 
                                              " | " + Math.max(0, Math.round((prevPlane.y + 61) * 100)) + "ft";
                            updateOrCreateTextBillboard(prevGroup, labelText, getCategoryColor(prevPlane.category));
                        }
                    }
                }
            }

            selectedPlaneId = id;
            const plane = planes.find(p => p.id === id);
            if (plane) {
                // Activate selection UI
                document.getElementById('selection-hud').classList.add('active');
                updateHUDDetails(plane);
                
                // Open and initialize VR 3D control panel
                openVRControlPanel(plane);
                
                // Highlight current selected plane's label color
                const group = planeMeshes[id];
                if (group) {
                    const labelText = (plane.custom_callsign || plane.callsign || plane.id) + 
                                      " | " + (plane.type || "UNK") + 
                                      " | " + Math.max(0, Math.round((plane.y + 61) * 100)) + "ft";
                    updateOrCreateTextBillboard(group, labelText, 0x00ff66);
                }
            }
        }

        function updateHUDDetails(plane) {
            const isGround = (plane.entity_type === 'automobile');
            const callsign = plane.custom_callsign || plane.callsign || plane.id;

            document.getElementById('hud-callsign').innerText = callsign;
            document.getElementById('hud-type').innerText = isGround ? "GROUND VEHICLE" : (plane.type || "UNK");
            document.getElementById('hud-squawk').innerText = plane.squawk || "STANDBY";
            document.getElementById('hud-altitude').innerText = isGround ? "GROUND LEVEL" : (Math.max(0, Math.round((plane.y + 61) * 100)) + " ft");
            document.getElementById('hud-status').innerText = plane.status.toUpperCase();
            document.getElementById('hud-route').innerText = isGround ? "AIRPORT SURFACE" : (plane.route || "NONE");
        }

        // --- VR CONTROLLER LOCOMOTION & SCALING ---
        let lastSnapTurnTime = 0;
        let lastStripBayToggleTime = 0;

        function handleXRInput() {
            const session = renderer.xr.getSession();
            if (!session) return;

            for (const source of session.inputSources) {
                if (!source.gamepad) continue;

                const axes = source.gamepad.axes;
                const buttons = source.gamepad.buttons;
                const hand = source.handedness;

                // Debug log axes structure every 5 seconds per hand to aid in telemetry testing
                if (!window.lastAxesLogTime) window.lastAxesLogTime = {};
                const now = Date.now();
                if (!window.lastAxesLogTime[hand] || now - window.lastAxesLogTime[hand] > 5000) {
                    console.log(`Gamepad [${hand}]: axes length = ${axes.length}, values = [${axes.map(x=>x.toFixed(2)).join(', ')}]`);
                    window.lastAxesLogTime[hand] = now;
                }

                // Determine correct stick values.
                // Standard xr-standard mapping maps thumbsticks to axes[2] & axes[3].
                // Fall back to axes[0] & axes[1] if axes length is smaller or if 2 & 3 are inactive.
                let stickX = 0;
                let stickY = 0;
                if (axes.length >= 4) {
                    stickX = axes[2];
                    stickY = axes[3];
                }
                if (Math.abs(stickX) < 0.05 && Math.abs(stickY) < 0.05 && axes.length >= 2) {
                    stickX = axes[0] || 0;
                    stickY = axes[1] || 0;
                }

                // 1. Locomotion & Radial Menu (Left Controller)
                if (hand === 'left') {
                    // Check left stick click (button 3 or button 2)
                    let leftClickPressed = (buttons.length > 3 && buttons[3] && buttons[3].pressed) || (buttons.length > 2 && buttons[2] && buttons[2].pressed);
                    
                    if (leftClickPressed) {
                        const now = Date.now();
                        if (!window.lastLeftClickTime) window.lastLeftClickTime = 0;
                        if (now - window.lastLeftClickTime > 400) {
                            window.lastLeftClickTime = now;
                            
                            if (spawningToolActive) {
                                spawningToolActive = null;
                                triggerHapticFeedback(0.5, 40);
                            } else if (leftRadialMenuOpen) {
                                // If menu is already open, click confirms selection (if any) or just closes
                                if (leftRadialMenuSelectedSegment !== -1) {
                                    executeLeftRadialAction(leftRadialMenuSelectedSegment);
                                } else {
                                    leftRadialMenuOpen = false;
                                    if (leftRadialMenuMesh) leftRadialMenuMesh.visible = false;
                                    triggerHapticFeedback(0.5, 40);
                                }
                            } else {
                                // Open left radial menu
                                leftRadialMenuOpen = true;
                                if (leftRadialMenuMesh) {
                                    leftRadialMenuMesh.visible = true;
                                    drawLeftRadialMenu(0, 0);
                                }
                                triggerHapticFeedback(0.5, 40);
                            }
                        }
                    }

                    if (leftRadialMenuOpen) {
                        // Suppress locomotion and use left stick to navigate radial menu
                        drawLeftRadialMenu(stickX, stickY);
                    } else {
                        // Standard locomotion
                        if (Math.abs(stickX) > 0.15 || Math.abs(stickY) > 0.15) {
                            targetDollyPos = null; // Cancel auto locomotion leash
                            const activeCam = renderer.xr.isPresenting ? renderer.xr.getCamera(camera) : camera;
                            const heading = new THREE.Vector3();
                            activeCam.getWorldDirection(heading);
                            heading.y = 0; // keep horizontal
                            heading.normalize();

                            const side = new THREE.Vector3();
                            side.crossVectors(heading, new THREE.Vector3(0, 1, 0)).normalize();

                            const speed = 0.04; 
                            const moveVec = new THREE.Vector3()
                                .addScaledVector(heading, -stickY * speed)
                                .addScaledVector(side, stickX * speed);
                            
                            dolly.position.add(moveVec);
                        }
                    }
                }

                // 2. Scaling & Snap Rotation (Right Controller)
                if (hand === 'right') {
                    // Toggle strip bay visibility on right stick click (button 3 is WebXR standard, button 2 is fallback)
                    let togglePressed = (buttons.length > 3 && buttons[3] && buttons[3].pressed) || (buttons.length > 2 && buttons[2] && buttons[2].pressed);
                    if (togglePressed) {
                        targetDollyPos = null; // Cancel auto locomotion leash
                        const now = Date.now();
                        if (now - lastStripBayToggleTime > 500) {
                            if (selectedPlaneId) {
                                // If a plane is selected, reopening strip bay deselects it!
                                console.log("VR: Reopening strip bay via button, deselecting aircraft");
                                closeVRControlPanel();
                                triggerHapticFeedback(0.5, 50);
                            } else {
                                if (stripBayTablet) {
                                    stripBayTablet.visible = !stripBayTablet.visible;
                                    console.log("VR: Toggle Strip Bay Tablet visibility to", stripBayTablet.visible);
                                    triggerHapticFeedback(0.5, 50);
                                }
                            }
                            lastStripBayToggleTime = now;
                        }
                    }

                    // Scaling (Right Stick vertical)
                    if (Math.abs(stickY) > 0.15) {
                        targetDollyPos = null; // Cancel auto locomotion leash
                        const scaleSpeed = 0.015;
                        chartConfig.scale = Math.max(0.05, Math.min(2.5, chartConfig.scale - stickY * scaleSpeed));
                        
                        const mapGroup = tableGroup.getObjectByName("map3DGroup");
                        if (mapGroup) {
                            mapGroup.scale.setScalar(chartConfig.scale * MC_TO_THREE_SCALE);
                        }
                        
                        // Update waypoint scales and positions in real-time
                        staticWaypoints.forEach(wp => {
                            const m = waypointMeshes[wp.id];
                            if (m) {
                                m.scale.setScalar(chartConfig.scale);
                                m.position.copy(worldToTable(wp.x, wp.z, wp.y));
                            }
                        });
                        
                    }

                    // Snap Turn (Right Stick horizontal)
                    if (Math.abs(stickX) > 0.6) {
                        targetDollyPos = null; // Cancel auto locomotion leash
                        const snapNow = Date.now();
                        if (snapNow - lastSnapTurnTime > 500) { 
                            const angle = (stickX > 0 ? -45 : 45) * Math.PI / 180;
                            
                            const camWorldPos = getActiveCameraWorldPosition();
                            
                            dolly.position.sub(camWorldPos);
                            dolly.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
                            dolly.position.add(camWorldPos);
                            
                            dolly.rotation.y += angle;
                            lastSnapTurnTime = snapNow;
                        }
                    }
                }

                // 3. Vertical movement (Y/B buttons to fly up, X/A buttons to fly down)
                if (buttons) {
                    const vSpeed = 0.03;
                    if (buttons.length > 5 && buttons[5] && buttons[5].pressed) {
                        targetDollyPos = null; // Cancel auto locomotion leash
                        dolly.position.y += vSpeed;
                    }
                    if (buttons.length > 4 && buttons[4] && buttons[4].pressed) {
                        targetDollyPos = null; // Cancel auto locomotion leash
                        dolly.position.y -= vSpeed;
                    }
                }
            }
        }

        // --- ANIMATE LOOP ---
        function animate() {
            // Check if calibration settings changed (optimized config caching)
            const configChanged = (lastAnimateScale !== chartConfig.scale || 
                                   lastAnimateRotation !== chartConfig.rotation || 
                                   lastAnimateX !== chartConfig.x || 
                                   lastAnimateZ !== chartConfig.z);
            if (configChanged) {
                lastAnimateScale = chartConfig.scale;
                lastAnimateRotation = chartConfig.rotation;
                lastAnimateX = chartConfig.x;
                lastAnimateZ = chartConfig.z;
            }

            // Update VR controller movement
            handleXRInput();

            // Update OrbitControls
            if (controls) controls.update();

            // Reset hover states
            hoveredWaypointId = null;
            hoveredPlaneId = null;
            hoveredObjectName = null;
            hoveredObjectDistance = null;
            panelHoverX = null;
            panelHoverY = null;
            tabletHoverX = null;
            tabletHoverY = null;
            awosHoverX = null;
            awosHoverY = null;

            controllers.forEach(controller => {
                const rayLine = controller.getObjectByName('ray');
                if (rayLine) {
                    let cutOffDist = 10.0;
                    
                    if (renderer.xr.isPresenting) {
                        tempMatrix.identity().extractRotation(controller.matrixWorld);
                        const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
                        const rayOrigin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
                        
                        raycaster.ray.origin.copy(rayOrigin);
                        raycaster.ray.direction.copy(rayDirection);
                        
                        const targets = [];
                        
                        // 1. Waypoints (only the top-level Sphere/Octahedron meshes, no recursion!)
                        Object.values(waypointMeshes).forEach(m => targets.push(m));
                        
                        // 2. Planes: add selection_collider and label billboard directly to targets (no recursion!)
                        Object.values(planeMeshes).forEach(group => {
                            const collider = group.getObjectByName("selection_collider");
                            if (collider) targets.push(collider);
                            const label = group.getObjectByName("label");
                            if (label && label.visible) targets.push(label);
                        });
                        
                        // 3. VR Control Panel
                        if (vrControlPanel && vrControlPanel.visible) {
                            const panelPage = vrControlPanel.getObjectByName("panelPage");
                            if (panelPage) targets.push(panelPage);
                        }
                        
                        // 4. Strip Bay Tablet Clipboard
                        if (stripBayTablet && stripBayTablet.visible) {
                            const clipboardMesh = stripBayTablet.getObjectByName("clipboardPage");
                            if (clipboardMesh) targets.push(clipboardMesh);
                        }
                        
                        if (awosTablet && awosTablet.visible) {
                            const awosPageMesh = awosTablet.getObjectByName("awosPage");
                            if (awosPageMesh) targets.push(awosPageMesh);
                        }
                        
                        // 5. Table Plane
                        if (tablePlane) {
                            targets.push(tablePlane);
                        }
                        
                        const intersects = raycaster.intersectObjects(targets, false); // recursive = false
                        if (intersects.length > 0) {
                            // Find if there is a UI panel hit first (they have absolute priority)
                            const panelPage = vrControlPanel ? vrControlPanel.getObjectByName("panelPage") : null;
                            const panelHit = intersects.find(h => (panelPage && h.object === panelPage) || (stripBayTablet && h.object.name === "clipboardPage"));
                            
                            let hit = intersects[0];
                            
                            if (panelHit) {
                                hit = panelHit;
                            } else if (selectedPlaneId) {
                                // Prioritize waypoints over planes/vehicles if they overlap in line of sight
                                const wpHit = intersects.find(h => h.object.userData && h.object.userData.type === 'waypoint');
                                if (wpHit) {
                                    hit = wpHit;
                                }
                            }
                            
                            cutOffDist = hit.distance;
                            const obj = hit.object;
                            
                            if (panelPage && obj === panelPage) {
                                const uv = hit.uv;
                                if (uv) {
                                    panelHoverX = uv.x * 512;
                                    panelHoverY = (1 - uv.y) * 512;
                                }
                            } else if (stripBayTablet && obj.name === "clipboardPage") {
                                const uv = hit.uv;
                                if (uv) {
                                    tabletHoverX = uv.x * 512;
                                    tabletHoverY = (1 - uv.y) * 512;
                                }
                            } else if (awosTablet && obj.name === "awosPage") {
                                const uv = hit.uv;
                                if (uv) {
                                    awosHoverX = uv.x * 512;
                                    awosHoverY = (1 - uv.y) * 512;
                                }
                            } else {
                                let wpId = null;
                                let planeId = null;
                                let current = obj;
                                while (current) {
                                    if (current.userData && current.userData.type === 'waypoint') {
                                        wpId = current.userData.id;
                                        break;
                                    }
                                    if (current.name && current.name.startsWith("plane_")) {
                                        planeId = current.name.replace("plane_", "");
                                        break;
                                    }
                                    current = current.parent;
                                }
                                
                                if (wpId) {
                                    hoveredWaypointId = wpId;
                                } else if (planeId) {
                                    hoveredPlaneId = planeId;
                                    hoveredObjectName = obj.name;
                                    hoveredObjectDistance = hit.distance;
                                }
                            }
                        }
                    }
                    if (controller === leftController && leftRadialMenuOpen) {
                        rayLine.visible = false;
                    } else {
                        rayLine.visible = true;
                        rayLine.scale.z = cutOffDist;
                    }
                }
            });

            // Apply hover visuals for waypoints
            staticWaypoints.forEach(wp => {
                const mesh = waypointMeshes[wp.id];
                if (mesh) {
                    const isHovered = (wp.id === hoveredWaypointId);
                    if (isHovered) {
                        mesh.scale.setScalar(chartConfig.scale * 1.5);
                        if (mesh.material) {
                            mesh.material.color.setHex(0x00ffff);
                        }
                    } else {
                        mesh.scale.setScalar(chartConfig.scale);
                        if (mesh.material) {
                            mesh.material.color.setHex(wp.y <= -50 ? 0xffaa00 : 0x00d2ff);
                        }
                    }
                }
            });

            // Redraw VR Control Panel if hover coordinates changed
            if (selectedPlaneId) {
                const plane = planes.find(p => p.id === selectedPlaneId);
                if (plane) {
                    if (panelHoverX !== lastPanelHoverX || panelHoverY !== lastPanelHoverY) {
                        drawVRControlPanel(plane, panelHoverX, panelHoverY);
                        lastPanelHoverX = panelHoverX;
                        lastPanelHoverY = panelHoverY;
                    }
                }
            } else {
                lastPanelHoverX = null;
                lastPanelHoverY = null;
            }

            // Redraw Strip Bay if hover coordinates changed
            if (stripBayTablet && stripBayTablet.visible) {
                if (tabletHoverX !== lastTabletHoverX || tabletHoverY !== lastTabletHoverY) {
                    drawStripBay(tabletHoverX, tabletHoverY);
                    lastTabletHoverX = tabletHoverX;
                    lastTabletHoverY = tabletHoverY;
                }
            } else {
                lastTabletHoverX = null;
                lastTabletHoverY = null;
            }

            // Redraw AWOS Tablet if hover coordinates changed
            if (awosTablet && awosTablet.visible) {
                if (awosHoverX !== lastAwosHoverX || awosHoverY !== lastAwosHoverY) {
                    drawAwosTablet(awosHoverX, awosHoverY);
                    lastAwosHoverX = awosHoverX;
                    lastAwosHoverY = awosHoverY;
                }
            } else {
                lastAwosHoverX = null;
                lastAwosHoverY = null;
            }

            // Smoothly move player dolly to target position if set
            if (targetDollyPos) {
                dolly.position.lerp(targetDollyPos, 0.08);
                if (dolly.position.distanceTo(targetDollyPos) < 0.02) {
                    targetDollyPos = null;
                }
            }

            // Handle tag dragging for controllers
            controllers.forEach(controller => {
                if (controller.userData.draggingTag) {
                    const dragInfo = controller.userData.draggingTag;
                    const planeGroup = planeMeshes[dragInfo.planeId];
                    if (planeGroup) {
                        tempMatrix.identity().extractRotation(controller.matrixWorld);
                        const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
                        const rayOrigin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
                        
                        const targetWorldPos = new THREE.Vector3().copy(rayOrigin).addScaledVector(rayDirection, dragInfo.distance);
                        const localPos = planeGroup.worldToLocal(targetWorldPos);
                        
                        // Constrain to stay above the plane
                        localPos.y = Math.max(0.05 * chartConfig.scale, localPos.y);
                        
                        const labelMesh = planeGroup.getObjectByName("label");
                        if (labelMesh) {
                            labelMesh.position.copy(localPos);
                        }
                    }
                }
            });

            // Smoothly interpolate plane positions in real-time
            planes.forEach(p => {
                const group = planeMeshes[p.id];
                if (group) {
                    // Smooth lerp for position (using cached targetVector)
                    if (!p.targetVector || configChanged) {
                        p.targetVector = worldToTable(p.targetX, p.targetZ, p.targetY);
                    }
                    group.position.lerp(p.targetVector, 0.1);

                    // Update local coordinates to match lerped position
                    let diffX = (group.position.x - (-chartConfig.x * MC_TO_THREE_SCALE)); // approximate reverse
                    // Save lerp progress
                    p.currentX += (p.targetX - p.currentX) * 0.1;
                    p.currentY += (p.targetY - p.currentY) * 0.1;
                    p.currentZ += (p.targetZ - p.currentZ) * 0.1;

                    // Set target rotation
                    // In Three.js, Y axis is up. The body points along positive Z.
                    // rotation.y represents heading rotation, offset by map calibration rotation
                    let targetRotationY = -(p.heading + (chartConfig.rotation || 0)) * Math.PI / 180;
                    
                    // Smoothly rotate body mesh
                    const body = group.getObjectByName("body");
                    if (body) {
                        // Handle circular angle interpolation
                        let diff = targetRotationY - body.rotation.y;
                        diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // normalize between -PI and PI
                        body.rotation.y += diff * 0.15;
                    }

                    // Highlight / Pulse selected plane, scaled by chartConfig.scale
                    const isSelected = (p.id === selectedPlaneId);
                    const bodyMesh = group.getObjectByName("body");
                    if (bodyMesh) {
                        if (isSelected) {
                            let pulse = 0.8 + 0.2 * Math.sin(Date.now() / 150);
                            bodyMesh.scale.setScalar(chartConfig.scale * pulse);
                        } else {
                            bodyMesh.scale.setScalar(chartConfig.scale);
                        }
                    }

                    const collider = group.getObjectByName("selection_collider");
                    if (collider) {
                        collider.scale.setScalar(chartConfig.scale);
                    }

                    // Update label billboard position offset dynamically on scale adjustments
                    const label = group.getObjectByName("label");
                    if (label) {
                        let isBeingDragged = false;
                        controllers.forEach(c => {
                            if (c.userData.draggingTag && c.userData.draggingTag.planeId === p.id) {
                                isBeingDragged = true;
                            }
                        });
                        if (desktopDraggingTag && desktopDraggingTag.planeId === p.id) {
                            isBeingDragged = true;
                        }
                        
                        if (!isBeingDragged) {
                            if (!label.userData.hasBeenDragged) {
                                label.position.set(0, 0.15 * chartConfig.scale, 0);
                            }
                        } else {
                            label.userData.hasBeenDragged = true;
                        }

                        // Y-axis billboarding
                        const headPos = getActiveCameraWorldPosition();
                        const worldLabelPos = new THREE.Vector3();
                        label.getWorldPosition(worldLabelPos);
                        const targetPos = new THREE.Vector3(
                            headPos.x,
                            worldLabelPos.y,
                            headPos.z
                        );
                        label.lookAt(targetPos);

                        // Constant screen size scaling — tuned for larger geometry
                        const dist = headPos.distanceTo(worldLabelPos);
                        let labelScale = dist * 0.25;
                        labelScale = Math.max(0.08, Math.min(0.8, labelScale));
                        label.scale.set(labelScale, labelScale, labelScale);

                        // Sync tag line geometry and visibility (optimized to avoid redundant buffer updates)
                        const tagLine = group.getObjectByName("tagLine");
                        if (tagLine) {
                            tagLine.visible = label.visible;
                            
                            const lastX = tagLine.userData ? tagLine.userData.lastLabelX : null;
                            const lastY = tagLine.userData ? tagLine.userData.lastLabelY : null;
                            const lastZ = tagLine.userData ? tagLine.userData.lastLabelZ : null;
                            
                            if (lastX !== label.position.x || lastY !== label.position.y || lastZ !== label.position.z) {
                                const positions = [
                                    0, 0, 0,
                                    label.position.x, label.position.y, label.position.z
                                ];
                                tagLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
                                tagLine.geometry.attributes.position.needsUpdate = true;
                                
                                if (!tagLine.userData) tagLine.userData = {};
                                tagLine.userData.lastLabelX = label.position.x;
                                tagLine.userData.lastLabelY = label.position.y;
                                tagLine.userData.lastLabelZ = label.position.z;
                            }
                        }
                    }
                }
            });

            // Make text billboard labels face the current active camera
            // (Three.js Sprite class handles this automatically, but group scaling/rotations can warp them)
            // So sprites are perfect and robust.

            // Update low-res shader inverse world matrix uniforms (optimized O(1) shared uniform update)
            if (sharedInverseWorldMatrixUniform && mapWrapperGroup && window.bluemap && window.bluemap.mapViewer && window.bluemap.mapViewer.map) {
                mapWrapperGroup.updateMatrixWorld(true);
                sharedInverseWorldMatrixUniform.value.copy(mapWrapperGroup.matrixWorld).invert();
            }

            // Smoothly animate and position the Floating VR Control Panel (optimized for attachment)
            if (vrControlPanel && vrControlPanel.visible) {
                if (rightController) {
                    // Panel is held in right hand. No-op (keep local pos/rot).
                } else {
                    let currentScale = vrControlPanel.scale.x;
                    let targetScale = vrControlPanelTargetScale * chartConfig.scale;
                    currentScale += (targetScale - currentScale) * 0.15;
                    vrControlPanel.scale.set(currentScale, currentScale, currentScale);
                    
                    if (currentScale > 0.01) {
                        vrControlPanel.visible = true;
                        // Position it above the selected plane
                        if (selectedPlaneId) {
                            const planeGroup = planeMeshes[selectedPlaneId];
                            if (planeGroup) {
                                vrControlPanel.position.copy(planeGroup.position);
                                vrControlPanel.position.y += 0.25 * chartConfig.scale;
                            }
                        }
                        // Billboard it to face the active camera
                        const headPos = getActiveCameraWorldPosition();
                        vrControlPanel.lookAt(headPos);
                    } else {
                        vrControlPanel.visible = false;
                    }
                }
            }

            // Update and animate route lines for all active planes
            planes.forEach(p => {
                drawRouteLine(p);
            });

            // Animate laser beam opacity for pulsing visual effect
            controllers.forEach(controller => {
                const rayLine = controller.getObjectByName('ray');
                if (rayLine && rayLine.material) {
                    rayLine.material.opacity = 0.35 + 0.1 * Math.sin(Date.now() * 0.005);
                }
            });

            // Render scene
            renderer.render(scene, camera);
        }

        // --- LEFT CONTROLLER RADIAL MENU & AWOS TABLET FUNCTIONS ---
        function createLeftRadialMenuMesh() {
            const group = new THREE.Group();

            leftRadialMenuCanvas = document.createElement('canvas');
            leftRadialMenuCanvas.width = 1024;
            leftRadialMenuCanvas.height = 1024;
            leftRadialMenuCtx = leftRadialMenuCanvas.getContext('2d');

            leftRadialMenuTexture = new THREE.CanvasTexture(leftRadialMenuCanvas);
            const circleGeo = new THREE.CircleGeometry(0.12, 32);
            const circleMat = new THREE.MeshBasicMaterial({
                map: leftRadialMenuTexture,
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const circleMesh = new THREE.Mesh(circleGeo, circleMat);
            circleMesh.name = "radialPage";
            group.add(circleMesh);

            // Backing glass disc
            const backGeo = new THREE.CircleGeometry(0.125, 32);
            const backMat = new THREE.MeshPhysicalMaterial({
                color: 0x070b19,
                roughness: 0.1,
                metalness: 0.1,
                transmission: 0.85,
                opacity: 0.35,
                transparent: true,
                depthWrite: false
            });
            const backMesh = new THREE.Mesh(backGeo, backMat);
            backMesh.position.z = -0.005;
            group.add(backMesh);

            group.visible = false;
            group.position.set(0.0, 0.05, -0.05);
            group.rotation.set(-Math.PI / 2.5, 0, 0); // Face the user

            return group;
        }

        function drawLeftRadialMenu(stickX, stickY) {
            if (!leftRadialMenuCanvas || !leftRadialMenuCtx) return;

            const ctx = leftRadialMenuCtx;
            ctx.clearRect(0, 0, leftRadialMenuCanvas.width, leftRadialMenuCanvas.height);
            ctx.save();
            ctx.scale(2, 2);

            const cx = 256;
            const cy = 256;
            const innerR = 65;
            const outerR = 230;

            // Determine selection
            let radius = Math.sqrt(stickX * stickX + stickY * stickY);
            let selected = -1;
            if (radius > 0.3) {
                let angle = Math.atan2(stickY, stickX);
                if (angle < 0) angle += 2 * Math.PI;
                if (angle >= 5 * Math.PI / 4 && angle < 7 * Math.PI / 4) selected = 0; // UP
                else if (angle >= 7 * Math.PI / 4 || angle < Math.PI / 4) selected = 1; // RIGHT
                else if (angle >= Math.PI / 4 && angle < 3 * Math.PI / 4) selected = 2; // DOWN
                else selected = 3; // LEFT
            }
            leftRadialMenuSelectedSegment = selected;

            // Draw sectors
            drawSector(ctx, cx, cy, innerR, outerR, 5 * Math.PI / 4, 7 * Math.PI / 4, selected === 0);
            drawSector(ctx, cx, cy, innerR, outerR, -Math.PI / 4, Math.PI / 4, selected === 1);
            drawSector(ctx, cx, cy, innerR, outerR, Math.PI / 4, 3 * Math.PI / 4, selected === 2);
            drawSector(ctx, cx, cy, innerR, outerR, 3 * Math.PI / 4, 5 * Math.PI / 4, selected === 3);

            // Draw center ring
            ctx.beginPath();
            ctx.arc(cx, cy, innerR - 2, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(5, 10, 20, 0.9)';
            ctx.fill();
            ctx.strokeStyle = '#00d2ff';
            ctx.lineWidth = 3;
            ctx.stroke();

            // Center text
            ctx.fillStyle = '#00d2ff';
            ctx.font = 'bold 20px "IBM Plex Sans", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("ATC", cx, cy - 8);
            ctx.fillStyle = '#ffffff';
            ctx.font = '9px "IBM Plex Sans", sans-serif';
            ctx.fillText("RADIAL", cx, cy + 12);

            // Draw Segment Content (Icons and Text)
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // UP Segment (0): Pause / Resume
            ctx.fillStyle = selected === 0 ? '#ffffff' : '#a0aec0';
            ctx.font = 'bold 16px "IBM Plex Sans", sans-serif';
            ctx.fillText(isPaused ? "RESUME SIM" : "PAUSE SIM", cx, cy - 135);
            ctx.font = '9px "IBM Plex Sans", sans-serif';
            ctx.fillText("UP", cx, cy - 115);
            if (isPaused) {
                // Draw Play Triangle
                ctx.beginPath();
                ctx.moveTo(cx - 8, cy - 175);
                ctx.lineTo(cx + 12, cy - 165);
                ctx.lineTo(cx - 8, cy - 155);
                ctx.closePath();
                ctx.fillStyle = selected === 0 ? '#00ffcc' : '#00b386';
                ctx.fill();
            } else {
                // Draw Pause Bars
                ctx.fillStyle = selected === 0 ? '#ff5555' : '#b33c3c';
                ctx.fillRect(cx - 10, cy - 175, 6, 20);
                ctx.fillRect(cx + 4, cy - 175, 6, 20);
            }

            // RIGHT Segment (1): Spawn plane
            ctx.fillStyle = selected === 1 ? '#ffffff' : '#a0aec0';
            ctx.font = 'bold 16px "IBM Plex Sans", sans-serif';
            ctx.fillText("SPAWN PLANE", cx + 135, cy);
            ctx.font = '9px "IBM Plex Sans", sans-serif';
            ctx.fillText("RIGHT", cx + 135, cy + 20);
            ctx.save();
            ctx.translate(cx + 135, cy - 25);
            ctx.scale(1.2, 1.2);
            ctx.beginPath();
            ctx.moveTo(0, -12); // Nose
            ctx.lineTo(3, -5);
            ctx.lineTo(12, -1); // Right wing tip
            ctx.lineTo(12, 2);
            ctx.lineTo(3, 1);
            ctx.lineTo(2, 8);
            ctx.lineTo(6, 11); // Right tail plane
            ctx.lineTo(6, 13);
            ctx.lineTo(0, 11); // Tail center
            ctx.lineTo(-6, 13);
            ctx.lineTo(-6, 11);
            ctx.lineTo(-2, 8);
            ctx.lineTo(-3, 1);
            ctx.lineTo(-12, 2); // Left wing tip
            ctx.lineTo(-12, -1);
            ctx.lineTo(-3, -5);
            ctx.closePath();
            ctx.fillStyle = selected === 1 ? '#00d2ff' : '#0099cc';
            ctx.fill();
            ctx.restore();

            // DOWN Segment (2): Weather toggle
            ctx.fillStyle = selected === 2 ? '#ffffff' : '#a0aec0';
            ctx.font = 'bold 16px "IBM Plex Sans", sans-serif';
            ctx.fillText(currentWeatherState === 'rain' ? "MAKE CLEAR" : "MAKE RAIN", cx, cy + 135);
            ctx.font = '9px "IBM Plex Sans", sans-serif';
            ctx.fillText("DOWN", cx, cy + 155);
            if (currentWeatherState === 'rain') {
                ctx.save();
                ctx.translate(cx, cy + 105);
                ctx.beginPath();
                ctx.arc(0, 0, 8, 0, 2 * Math.PI);
                ctx.fillStyle = selected === 2 ? '#ffcc00' : '#b38f00';
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = selected === 2 ? '#ffcc00' : '#b38f00';
                for (let a = 0; a < 360; a += 45) {
                    const r = a * Math.PI / 180;
                    ctx.beginPath();
                    ctx.moveTo(Math.cos(r) * 11, Math.sin(r) * 11);
                    ctx.lineTo(Math.cos(r) * 15, Math.sin(r) * 15);
                    ctx.stroke();
                }
                ctx.restore();
            } else {
                ctx.save();
                ctx.translate(cx, cy + 105);
                ctx.beginPath();
                ctx.arc(-6, 3, 6, 0, 2 * Math.PI);
                ctx.arc(0, -3, 8, 0, 2 * Math.PI);
                ctx.arc(6, 3, 6, 0, 2 * Math.PI);
                ctx.closePath();
                ctx.fillStyle = selected === 2 ? '#8899aa' : '#556677';
                ctx.fill();
                ctx.strokeStyle = '#00d2ff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(-4, 9); ctx.lineTo(-6, 14);
                ctx.moveTo(1, 9); ctx.lineTo(-1, 14);
                ctx.moveTo(6, 9); ctx.lineTo(4, 14);
                ctx.stroke();
                ctx.restore();
            }

            // LEFT Segment (3): AWOS toggle
            let awosActive = awosTablet && awosTablet.visible;
            ctx.fillStyle = selected === 3 ? '#ffffff' : '#a0aec0';
            ctx.font = 'bold 16px "IBM Plex Sans", sans-serif';
            ctx.fillText(awosActive ? "HIDE AWOS" : "SHOW AWOS", cx - 135, cy);
            ctx.font = '9px "IBM Plex Sans", sans-serif';
            ctx.fillText("LEFT", cx - 135, cy + 20);
            ctx.save();
            ctx.translate(cx - 135, cy - 20);
            ctx.lineWidth = 2;
            ctx.strokeStyle = selected === 3 ? '#00ff66' : '#00b347';
            ctx.strokeRect(-12, -10, 24, 20);
            ctx.beginPath();
            ctx.arc(0, 0, 6, 0, 2 * Math.PI);
            ctx.moveTo(0, -6); ctx.lineTo(0, 6);
            ctx.moveTo(-6, 0); ctx.lineTo(6, 0);
            ctx.stroke();
            ctx.restore();

            // Draw glowing thumbstick position dot
            ctx.beginPath();
            ctx.arc(cx + stickX * 160, cy + stickY * 160, 10, 0, 2 * Math.PI);
            ctx.fillStyle = '#ffffff';
            ctx.shadowColor = '#00d2ff';
            ctx.shadowBlur = 15;
            ctx.fill();
            ctx.shadowBlur = 0;

            ctx.restore();
            leftRadialMenuTexture.needsUpdate = true;
        }

        function drawSector(ctx, cx, cy, innerR, outerR, startAngle, endAngle, isSelected) {
            ctx.beginPath();
            ctx.arc(cx, cy, outerR, startAngle, endAngle, false);
            ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
            ctx.closePath();
            
            if (isSelected) {
                ctx.fillStyle = 'rgba(0, 210, 255, 0.45)';
                ctx.fill();
                ctx.strokeStyle = '#00d2ff';
                ctx.lineWidth = 4;
                ctx.stroke();
            } else {
                ctx.fillStyle = 'rgba(10, 20, 40, 0.55)';
                ctx.fill();
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }

        function executeLeftRadialAction(segment) {
            console.log("Executing Left Radial Action for segment:", segment);
            triggerHapticFeedback(0.8, 100);

            if (segment === 0) {
                const targetState = !isPaused;
                isPaused = targetState;
                fetch('/toggle_pause', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ paused: targetState })
                })
                .then(r => r.json())
                .catch(err => console.error("RCON Pause Error:", err));
            } 
            else if (segment === 1) {
                if (leftController && tablePlane) {
                    const tempRaycaster = new THREE.Raycaster();
                    const tempMatrix = new THREE.Matrix4();
                    tempMatrix.identity().extractRotation(leftController.matrixWorld);
                    const rayDirection = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
                    const rayOrigin = new THREE.Vector3().setFromMatrixPosition(leftController.matrixWorld);

                    tempRaycaster.ray.origin.copy(rayOrigin);
                    tempRaycaster.ray.direction.copy(rayDirection);

                    const intersects = tempRaycaster.intersectObject(tablePlane);
                    if (intersects.length > 0) {
                        const hitPoint = intersects[0].point;
                        const mcCoords = tableToWorld(hitPoint.x, hitPoint.z);
                        
                        fetch('/spawn_plane', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                x: Math.round(mcCoords.x),
                                z: Math.round(mcCoords.z),
                                type: 'simpleplanes:plane',
                                flight_rules: 'VFR'
                            })
                        })
                        .then(r => r.json())
                        .catch(err => console.error("Spawn Plane Error:", err));
                    }
                }
            } 
            else if (segment === 2) {
                const targetWeather = currentWeatherState === 'rain' ? 'clear' : 'rain';
                currentWeatherState = targetWeather;
                fetch('/set_weather', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: targetWeather })
                })
                .then(r => r.json())
                .catch(err => console.error("RCON Weather Error:", err));
            } 
            else if (segment === 3) {
                if (awosTablet) {
                    awosTablet.visible = !awosTablet.visible;
                    if (awosTablet.visible) {
                        updateAwosData();
                    }
                }
            }

            leftRadialMenuOpen = false;
            if (leftRadialMenuMesh) leftRadialMenuMesh.visible = false;
        }

        function createAwosTablet() {
            const group = new THREE.Group();

            awosCanvas = document.createElement('canvas');
            awosCanvas.width = 1024;
            awosCanvas.height = 1024;
            awosCtx = awosCanvas.getContext('2d');

            awosTexture = new THREE.CanvasTexture(awosCanvas);
            const pageGeo = new THREE.PlaneGeometry(0.3, 0.4);
            const pageMat = new THREE.MeshBasicMaterial({
                map: awosTexture,
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false
            });
            const pageMesh = new THREE.Mesh(pageGeo, pageMat);
            pageMesh.name = "awosPage";
            group.add(pageMesh);

            const backGeo = new THREE.PlaneGeometry(0.32, 0.42);
            const backMat = new THREE.MeshPhysicalMaterial({
                color: 0x070b19,
                roughness: 0.1,
                metalness: 0.1,
                transmission: 0.85,
                opacity: 0.35,
                transparent: true,
                depthWrite: false
            });
            const backMesh = new THREE.Mesh(backGeo, backMat);
            backMesh.position.z = -0.005;
            group.add(backMesh);

            const topBarGeo = new THREE.BoxGeometry(0.1, 0.02, 0.01);
            const topBarMat = new THREE.MeshStandardMaterial({
                color: 0x00ffff,
                roughness: 0.1,
                metalness: 0.9
            });
            const topBarMesh = new THREE.Mesh(topBarGeo, topBarMat);
            topBarMesh.position.set(0, 0.19, 0.005);
            group.add(topBarMesh);

            group.visible = false;
            group.position.set(0.0, 0.18, -0.12);
            group.rotation.set(-Math.PI / 3, 0, 0);

            return group;
        }

        function drawAwosTablet(hoverX = null, hoverY = null) {
            if (!awosCanvas || !awosCtx) return;

            const ctx = awosCtx;
            ctx.clearRect(0, 0, awosCanvas.width, awosCanvas.height);
            ctx.save();
            ctx.scale(2, 2);

            const w = 512;
            const h = 512;

            const grad = ctx.createLinearGradient(0, 0, 0, h);
            grad.addColorStop(0, 'rgba(10, 15, 30, 0.4)');
            grad.addColorStop(1, 'rgba(5, 7, 15, 0.55)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);

            ctx.strokeStyle = 'rgba(0, 210, 255, 0.15)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(10, 10, w - 20, h - 20);
            ctx.beginPath();
            ctx.moveTo(10, 60); ctx.lineTo(w - 10, 60);
            ctx.moveTo(10, 280); ctx.lineTo(w - 10, 280);
            ctx.moveTo(250, 60); ctx.lineTo(250, 280);
            ctx.stroke();

            ctx.fillStyle = '#00d2ff';
            ctx.font = 'bold 22px "IBM Plex Sans", sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText("KMCX AWOS STATION", 25, 42);

            ctx.textAlign = 'right';
            ctx.fillStyle = '#00ff66';
            ctx.font = '12px "IBM Plex Sans", sans-serif';
            ctx.fillText("• SYSTEM ACTIVE", w - 25, 40);

            const state = awosData || {
                windDir: 340, windSpd: 12, windGust: 0,
                temp: 18, dew: 10, qnh: 1013, qfe: 898, vis: 9999
            };

            const cx = 130;
            const cy = 170;
            const r = 70;

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, 2 * Math.PI);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx, cy, r - 15, 0, 2 * Math.PI);
            ctx.strokeStyle = 'rgba(0, 210, 255, 0.1)';
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 12px "IBM Plex Sans", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText("N", cx, cy - r + 10);
            ctx.fillText("S", cx, cy + r - 10);
            ctx.fillText("E", cx + r - 10, cy);
            ctx.fillText("W", cx - r + 10, cy);

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            ctx.lineWidth = 1;
            for (let deg = 0; deg < 360; deg += 30) {
                if (deg % 90 === 0) continue;
                const rad = deg * Math.PI / 180;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(rad) * (r - 4), cy + Math.sin(rad) * (r - 4));
                ctx.lineTo(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r);
                ctx.stroke();
            }

            ctx.save();
            ctx.translate(cx, cy);
            const windAngle = (state.windDir - 90) * Math.PI / 180;
            ctx.rotate(windAngle);

            ctx.beginPath();
            ctx.moveTo(0, -r + 5);
            ctx.lineTo(5, -r + 20);
            ctx.lineTo(2, -r + 20);
            ctx.lineTo(2, r - 20);
            ctx.lineTo(-2, r - 20);
            ctx.lineTo(-2, -r + 20);
            ctx.lineTo(-5, -r + 20);
            ctx.closePath();
            ctx.fillStyle = '#00d2ff';
            ctx.fill();
            
            ctx.beginPath();
            ctx.arc(0, 0, 5, 0, 2 * Math.PI);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.restore();

            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            
            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("WIND DIRECTION", 270, 95);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 24px "IBM Plex Sans", sans-serif';
            ctx.fillText(state.windDir.toString().padStart(3, '0') + "°", 270, 125);
            // Wind Dir Buttons
            drawAwosButton(ctx, "-10", 340, 103, 30, 20, hoverX, hoverY);
            drawAwosButton(ctx, "+10", 380, 103, 30, 20, hoverX, hoverY);

            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("WIND SPEED", 270, 155);
            ctx.fillStyle = '#ff8800';
            ctx.font = 'bold 28px "IBM Plex Sans", sans-serif';
            ctx.fillText(state.windSpd + " KT", 270, 185);
            // Wind Spd Buttons
            drawAwosButton(ctx, "-", 360, 168, 25, 20, hoverX, hoverY);
            drawAwosButton(ctx, "+", 395, 168, 25, 20, hoverX, hoverY);

            ctx.fillStyle = state.windGust > 0 ? '#ff3333' : '#a0aec0';
            ctx.font = 'bold 12px "IBM Plex Sans", sans-serif';
            ctx.fillText(`GUSTS: ${state.windGust} KT`, 270, 215);
            // Wind Gust Buttons
            drawAwosButton(ctx, "-", 360, 200, 25, 20, hoverX, hoverY);
            drawAwosButton(ctx, "+", 395, 200, 25, 20, hoverX, hoverY);

            const diffRad = (state.windDir - 30) * Math.PI / 180;
            const hw = state.windSpd * Math.cos(diffRad);
            const xw = Math.abs(state.windSpd * Math.sin(diffRad));
            const hwRound = Math.round(hw);
            const xwRound = Math.round(xw);

            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("RWY 03 COMPONENT", 270, 240);
            ctx.font = 'bold 13px "IBM Plex Sans", sans-serif';
            if (hwRound >= 0) {
                ctx.fillStyle = '#00ff66';
                ctx.fillText(`HW: ${hwRound} KT`, 270, 262);
            } else {
                ctx.fillStyle = '#ff3333';
                ctx.fillText(`TW: ${Math.abs(hwRound)} KT`, 270, 262);
            }
            ctx.fillStyle = '#00d2ff';
            ctx.fillText(`XW: ${xwRound} KT`, 370, 262);

            ctx.strokeStyle = 'rgba(255,255,255,0.05)';
            ctx.lineWidth = 1;

            const gridX1 = 40, gridX2 = 280;
            const gridY1 = 330, gridY2 = 410, gridY3 = 480;

            ctx.textAlign = 'left';
            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("TEMPERATURE", gridX1, gridY1 - 15);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 20px "IBM Plex Sans", sans-serif';
            ctx.fillText(state.temp + "°C", gridX1, gridY1);
            // Temp Buttons
            drawAwosButton(ctx, "-", gridX1 + 65, gridY1 - 18, 20, 18, hoverX, hoverY);
            drawAwosButton(ctx, "+", gridX1 + 90, gridY1 - 18, 20, 18, hoverX, hoverY);

            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("DEWPOINT", gridX2, gridY1 - 15);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 20px "IBM Plex Sans", sans-serif';
            ctx.fillText(state.dew + "°C", gridX2, gridY1);
            // Dew Buttons
            drawAwosButton(ctx, "-", gridX2 + 65, gridY1 - 18, 20, 18, hoverX, hoverY);
            drawAwosButton(ctx, "+", gridX2 + 90, gridY1 - 18, 20, 18, hoverX, hoverY);

            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("ALTIMETER QNH", gridX1, gridY2 - 15);
            ctx.fillStyle = '#00ffcc';
            ctx.font = 'bold 20px "IBM Plex Sans", sans-serif';
            ctx.fillText(state.qnh + " hPa", gridX1, gridY2);
            // QNH Buttons
            drawAwosButton(ctx, "-", gridX1 + 100, gridY2 - 18, 20, 18, hoverX, hoverY);
            drawAwosButton(ctx, "+", gridX1 + 125, gridY2 - 18, 20, 18, hoverX, hoverY);

            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("ALTIMETER QFE", gridX2, gridY2 - 15);
            ctx.fillStyle = '#00ffcc';
            ctx.font = 'bold 20px "IBM Plex Sans", sans-serif';
            ctx.fillText(state.qfe + " hPa", gridX2, gridY2);
            // QFE Buttons
            drawAwosButton(ctx, "-", gridX2 + 100, gridY2 - 18, 20, 18, hoverX, hoverY);
            drawAwosButton(ctx, "+", gridX2 + 125, gridY2 - 18, 20, 18, hoverX, hoverY);

            ctx.fillStyle = '#a0aec0';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.fillText("VISIBILITY", gridX1, gridY3 - 15);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 20px "IBM Plex Sans", sans-serif';
            const visStr = state.vis === 9999 ? "10 km+" : (state.vis + " m");
            ctx.fillText(visStr, gridX1, gridY3);
            // Visibility Buttons
            drawAwosButton(ctx, "-", gridX1 + 110, gridY3 - 18, 20, 18, hoverX, hoverY);
            drawAwosButton(ctx, "+", gridX1 + 135, gridY3 - 18, 20, 18, hoverX, hoverY);

            ctx.strokeStyle = 'rgba(0, 210, 255, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(gridX2, gridY3 - 12);
            for (let i = 0; i < 15; i++) {
                const px = gridX2 + i * 12;
                const py = gridY3 - 12 + Math.sin(Date.now() * 0.002 + i * 0.8) * 8;
                ctx.lineTo(px, py);
            }
            ctx.stroke();

            ctx.restore();
            awosTexture.needsUpdate = true;
        }

        function drawAwosButton(ctx, text, x, y, w, h, hoverX, hoverY) {
            const isHovered = (hoverX !== null && hoverY !== null && hoverX >= x && hoverX <= x + w && hoverY >= y && hoverY <= y + h);
            ctx.save();
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(x, y, w, h, 4);
            } else {
                ctx.rect(x, y, w, h);
            }
            if (isHovered) {
                ctx.fillStyle = 'rgba(0, 210, 255, 0.35)';
                ctx.strokeStyle = '#00d2ff';
            } else {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
                ctx.strokeStyle = 'rgba(0, 210, 255, 0.2)';
            }
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.stroke();
            
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 11px "IBM Plex Sans", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x + w / 2, y + h / 2);
            ctx.restore();
        }

        function handleAwosClick(x, y) {
            triggerHapticFeedback(0.6, 50);
            
            const state = awosData || {
                windDir: 340, windSpd: 12, windGust: 0,
                temp: 18, dew: 10, qnh: 1013, qfe: 898, vis: 9999
            };

            const gridX1 = 40, gridX2 = 280;
            const gridY1 = 330, gridY2 = 410, gridY3 = 480;

            let updated = false;

            function inBounds(btnX, btnY, w, h) {
                return (x >= btnX && x <= btnX + w && y >= btnY && y <= btnY + h);
            }

            if (inBounds(340, 103, 30, 20)) { state.windDir = (state.windDir - 10 + 360) % 360; updated = true; }
            else if (inBounds(380, 103, 30, 20)) { state.windDir = (state.windDir + 10) % 360; updated = true; }
            else if (inBounds(360, 168, 25, 20)) { state.windSpd = Math.max(0, state.windSpd - 1); updated = true; }
            else if (inBounds(395, 168, 25, 20)) { state.windSpd = Math.min(100, state.windSpd + 1); updated = true; }
            else if (inBounds(360, 200, 25, 20)) { state.windGust = Math.max(0, state.windGust - 1); updated = true; }
            else if (inBounds(395, 200, 25, 20)) { state.windGust = Math.min(100, state.windGust + 1); updated = true; }
            else if (inBounds(gridX1 + 65, gridY1 - 18, 20, 18)) { state.temp -= 1; updated = true; }
            else if (inBounds(gridX1 + 90, gridY1 - 18, 20, 18)) { state.temp += 1; updated = true; }
            else if (inBounds(gridX2 + 65, gridY1 - 18, 20, 18)) { state.dew -= 1; updated = true; }
            else if (inBounds(gridX2 + 90, gridY1 - 18, 20, 18)) { state.dew += 1; updated = true; }
            else if (inBounds(gridX1 + 100, gridY2 - 18, 20, 18)) { state.qnh -= 1; updated = true; }
            else if (inBounds(gridX1 + 125, gridY2 - 18, 20, 18)) { state.qnh += 1; updated = true; }
            else if (inBounds(gridX2 + 100, gridY2 - 18, 20, 18)) { state.qfe -= 1; updated = true; }
            else if (inBounds(gridX2 + 125, gridY2 - 18, 20, 18)) { state.qfe += 1; updated = true; }
            else if (inBounds(gridX1 + 110, gridY3 - 18, 20, 18)) { state.vis = Math.max(0, state.vis - 1000); updated = true; }
            else if (inBounds(gridX1 + 135, gridY3 - 18, 20, 18)) { state.vis = Math.min(9999, state.vis + 1000); updated = true; }

            if (updated) {
                awosData = state;
                drawAwosTablet(x, y);
                
                fetch('/update_awos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state)
                })
                .then(r => r.json())
                .catch(err => console.error("Error updating AWOS:", err));
            }
        }

        function updateAwosData() {
            fetch('/get_awos')
                .then(r => r.json())
                .then(data => {
                    awosData = data;
                    drawAwosTablet();
                })
                .catch(err => console.error("Error polling AWOS data:", err));
        }

        function onWindowResize() {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        }

        // Run
        function startInitialization() {
            const checkTimer = setInterval(() => {
                if (window.BlueMap && window.BlueMap.Three) {
                    clearInterval(checkTimer);
                    // Copy properties to an extensible plain object to allow OrbitControls to attach itself
                    window.THREE = Object.assign({}, window.BlueMap.Three);
                    
                    console.log("Matched BlueMap Three.js version: r" + window.THREE.REVISION);
                    
                    // Load local OrbitControls
                    const script = document.createElement('script');
                    script.src = "assets/OrbitControls.js";
                    script.onload = () => {
                        console.log("Successfully loaded local OrbitControls");
                        init();
                    };
                    script.onerror = () => {
                        console.error("Failed to load local OrbitControls");
                    };
                    document.head.appendChild(script);
                }
            }, 50);
        }

        startInitialization();
    