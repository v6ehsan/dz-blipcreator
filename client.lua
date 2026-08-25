local menuOpen = false
local activeBlips = {}       -- [uid] = {handle=, data={sprite,color,scale,label,coords}}
local activeMarkers = {}     -- [uid] = {data={type,color(r,g,b,a),scale,coords,label}}
local activeCheckpoints = {} -- [uid] = {handle=, data={checkpointType,r,g,b,a,radius,coords}}

-- ============ REQUEST/RESPONSE HELPER ============
-- Tiny RPC pattern: fire an event to the server with a reqId and get a
-- single 'dzblip:client:requestResult' reply back carrying that same reqId,
-- so a NUI callback can await the server's decision (uid assigned,
-- permission denied, etc) instead of trusting the client alone.
local pendingRequests = {}
local reqCounter = 0

local function request(eventName, payload, cb)
    reqCounter = reqCounter + 1
    local reqId = reqCounter
    pendingRequests[reqId] = cb
    TriggerServerEvent(eventName, reqId, payload)
end

RegisterNetEvent('dzblip:client:requestResult')
AddEventHandler('dzblip:client:requestResult', function(reqId, result)
    local cb = pendingRequests[reqId]
    if cb then
        pendingRequests[reqId] = nil
        cb(result)
    end
end)

-- ============ APPLY / REMOVE A POINT LOCALLY ============
-- These run on EVERY client (triggered by the server), which is what makes
-- a blip/marker/checkpoint created by one admin visible to everyone else,
-- and to anyone who joins afterward.

-- Native CreateCheckpoint has no direct "heading" parameter - the arrow
-- direction comes from where the SECOND coord (the "point towards" /
-- next-checkpoint position) sits relative to the first. This turns a plain
-- 0-360 heading into that synthetic second point, using GTA's convention of
-- 0 = north, clockwise.
local function headingToPointTowards(cx, cy, cz, heading, distance)
    local rad = math.rad(tonumber(heading) or 0.0)
    return cx + math.sin(rad) * distance, cy + math.cos(rad) * distance, cz
end

local function applyPoint(point)
    local uid, kind, d = point.uid, point.kind, point.data

    if kind == 'blip' then
        local blip = AddBlipForCoord(d.coords.x + 0.0, d.coords.y + 0.0, d.coords.z + 0.0)
        SetBlipSprite(blip, tonumber(d.sprite))
        SetBlipColour(blip, tonumber(d.color))
        SetBlipScale(blip, tonumber(d.scale) or 1.0)
        SetBlipRotation(blip, math.floor(tonumber(d.heading) or 0))
        SetBlipAsShortRange(blip, false)
        BeginTextCommandSetBlipName('STRING')
        AddTextComponentSubstringPlayerName(d.label ~= '' and d.label or (d.typeName or 'DZ Blip'))
        EndTextCommandSetBlipName(blip)
        activeBlips[uid] = { handle = blip, data = d }

    elseif kind == 'marker' then
        activeMarkers[uid] = { data = d }

    elseif kind == 'checkpoint' then
        local radius = tonumber(d.radius) or 5.0
        local cx, cy, cz = d.coords.x + 0.0, d.coords.y + 0.0, d.coords.z + 0.0
        local r, g, b, a = tonumber(d.r) or 255, tonumber(d.g) or 0, tonumber(d.b) or 255, tonumber(d.a) or 150
        local nx, ny, nz = headingToPointTowards(cx, cy, cz, d.heading, radius)

        local handle = CreateCheckpoint(
            tonumber(d.checkpointType),
            cx, cy, cz,
            nx, ny, nz,
            radius,
            r, g, b, a,
            0
        )
        -- CreateCheckpoint alone leaves the cylinder height at 0, which makes
        -- the checkpoint invisible even though it was created successfully.
        SetCheckpointCylinderHeight(handle, 2.0, 2.0, radius)
        print(('[dz-blipcreator] checkpoint %s created: handle=%s type=%s pos=%.2f,%.2f,%.2f radius=%.1f rgba=%s,%s,%s,%s')
            :format(uid, tostring(handle), tostring(d.checkpointType), cx, cy, cz, radius, r, g, b, a))
        activeCheckpoints[uid] = { handle = handle, data = d }
    end
end

local function removePointLocal(uid)
    if activeBlips[uid] then
        if activeBlips[uid].handle then RemoveBlip(activeBlips[uid].handle) end
        activeBlips[uid] = nil
    end
    if activeMarkers[uid] then
        activeMarkers[uid] = nil
    end
    if activeCheckpoints[uid] then
        if activeCheckpoints[uid].handle then DeleteCheckpoint(activeCheckpoints[uid].handle) end
        activeCheckpoints[uid] = nil
    end
end

local function clearAllLocal()
    for _, entry in pairs(activeBlips) do
        if entry.handle then RemoveBlip(entry.handle) end
    end
    for _, entry in pairs(activeCheckpoints) do
        if entry.handle then DeleteCheckpoint(entry.handle) end
    end
    activeBlips = {}
    activeMarkers = {}
    activeCheckpoints = {}
end

-- ============ LIVE PREVIEW ============
-- Purely local, never touches the server and is never saved - lets the menu
-- show a real-time in-game preview of the blip/marker/checkpoint currently
-- being configured, updated on every slider/field change, so the admin can
-- see exactly what they're about to add before clicking "Add to Map".
local previewBlipHandle = nil
local previewMarkerData = nil
local previewCheckpointHandle = nil

local function clearBlipPreview()
    if previewBlipHandle then
        RemoveBlip(previewBlipHandle)
        previewBlipHandle = nil
    end
end

local function clearMarkerPreview()
    previewMarkerData = nil
end

local function clearCheckpointPreview()
    if previewCheckpointHandle then
        DeleteCheckpoint(previewCheckpointHandle)
        previewCheckpointHandle = nil
    end
end

local function clearAllPreviews()
    clearBlipPreview()
    clearMarkerPreview()
    clearCheckpointPreview()
end

-- ============ SERVER BROADCASTS ============

RegisterNetEvent('dzblip:client:pointCreated')
AddEventHandler('dzblip:client:pointCreated', function(point)
    applyPoint(point)
end)

RegisterNetEvent('dzblip:client:pointRemoved')
AddEventHandler('dzblip:client:pointRemoved', function(uid)
    removePointLocal(uid)
end)

RegisterNetEvent('dzblip:client:clearAll')
AddEventHandler('dzblip:client:clearAll', function()
    clearAllLocal()
end)

-- Sent only to this client: the full saved list, applied fresh every time
-- (resource start, reconnect, or opening the menu) so nothing is ever stale
-- or duplicated.
RegisterNetEvent('dzblip:client:fullSync')
AddEventHandler('dzblip:client:fullSync', function(list)
    clearAllLocal()
    for _, point in pairs(list) do
        applyPoint(point)
    end
    if menuOpen then
        SendNUIMessage({ action = 'syncActive', points = list })
    end
end)

-- Pull everything saved as soon as the resource starts, so a restart/
-- reconnect shows the exact same map state without any manual step.
CreateThread(function()
    TriggerServerEvent('dzblip:server:requestSync')
end)

-- ============ MENU OPEN/CLOSE ============

local function openMenu()
    if menuOpen then return end
    menuOpen = true
    SetNuiFocus(true, true)
    local coords = GetEntityCoords(PlayerPedId())
    SendNUIMessage({
        action = 'open',
        blips = Config.Blips,
        markers = Config.Markers,
        checkpoints = Config.Checkpoints,
        colors = Config.BlipColors,
        defaults = Config.Defaults,
        playerCoords = { x = coords.x, y = coords.y, z = coords.z }
    })
    -- refresh the Active Items list with the server's authoritative state
    -- every time the menu is opened (covers points other admins placed)
    TriggerServerEvent('dzblip:server:requestSync')
end

local function closeMenu()
    if not menuOpen then return end
    menuOpen = false
    SetNuiFocus(false, false)
    SendNUIMessage({ action = 'close' })
    clearAllPreviews()
end

RegisterCommand('dzblip', function()
    if menuOpen then
        closeMenu()
        return
    end
    -- ask the server first (Config.AccessMode = 'admin' blocks non-admins
    -- from even opening the menu, rather than letting them see it and only
    -- rejecting the first thing they try to do)
    request('dzblip:server:checkAccess', nil, function(result)
        if result and result.allowed then
            openMenu()
        else
            BeginTextCommandThefeedPost('STRING')
            AddTextComponentSubstringPlayerName('~r~DZ-BlipCreator: you do not have permission to use this menu.')
            EndTextCommandThefeedPostTicker(false, false)
        end
    end)
end, false)

RegisterKeyMapping('dzblip', 'Open DZ-BlipCreator menu', 'keyboard', Config.OpenKey)

-- ============ DIAGNOSTIC: RAW CHECKPOINT TEST ============
-- Creates ONE checkpoint using the exact example from FiveM's own docs
-- (type 2, nothing fancy), completely bypassing our config/UI/server code.
-- If this doesn't render either, the problem is environmental (game
-- build, a conflicting resource, streaming) and not something in
-- DZ-BlipCreator's code - which tells us exactly where to look next.
local testCheckpoint = nil
RegisterCommand('dztestcheckpoint', function()
    if testCheckpoint then
        DeleteCheckpoint(testCheckpoint)
        testCheckpoint = nil
    end
    local coords = GetEntityCoords(PlayerPedId())
    testCheckpoint = CreateCheckpoint(
        2, -- Type (thick chevron up) - the exact type used in FiveM's own docs example
        coords.x, coords.y, coords.z,
        coords.x, coords.y, coords.z,
        5.0,
        255, 255, 0, 200,
        0
    )
    SetCheckpointCylinderHeight(testCheckpoint, 2.0, 2.0, 5.0)
    print(('[dz-blipcreator] TEST checkpoint handle=%s at %.2f,%.2f,%.2f - look down/around you now')
        :format(tostring(testCheckpoint), coords.x, coords.y, coords.z))
    BeginTextCommandThefeedPost('STRING')
    AddTextComponentSubstringPlayerName('~y~Test checkpoint spawned at your feet - do you see a yellow chevron?')
    EndTextCommandThefeedPostTicker(false, false)
end, false)

-- Same idea, but lets you punch in any raw type ID to see exactly what
-- that number renders as ON YOUR SERVER's game build - use this to map
-- out which IDs actually correspond to which visuals for you, since the
-- ID table shifts between game builds (see docs.fivem.net/docs/
-- game-references/checkpoints).
-- Usage: /dztestcp 3
RegisterCommand('dztestcp', function(_, args)
    local id = tonumber(args[1])
    if not id then
        print('[dz-blipcreator] usage: /dztestcp <id>  e.g. /dztestcp 3')
        return
    end
    if testCheckpoint then
        DeleteCheckpoint(testCheckpoint)
        testCheckpoint = nil
    end
    local coords = GetEntityCoords(PlayerPedId())
    testCheckpoint = CreateCheckpoint(
        id,
        coords.x, coords.y, coords.z,
        coords.x, coords.y, coords.z,
        5.0,
        255, 0, 255, 200,
        0
    )
    SetCheckpointCylinderHeight(testCheckpoint, 2.0, 2.0, 5.0)
    print(('[dz-blipcreator] TEST checkpoint type=%s handle=%s - look at your feet')
        :format(id, tostring(testCheckpoint)))
    BeginTextCommandThefeedPost('STRING')
    AddTextComponentSubstringPlayerName('~y~Type ' .. id .. ' spawned - what does it look like?')
    EndTextCommandThefeedPostTicker(false, false)
end, false)

-- ============ NUI CALLBACKS ============

RegisterNUICallback('closeMenu', function(_, cb)
    closeMenu()
    cb('ok')
end)

RegisterNUICallback('getPlayerCoords', function(_, cb)
    local coords = GetEntityCoords(PlayerPedId())
    local heading = GetEntityHeading(PlayerPedId())
    cb({ x = coords.x, y = coords.y, z = coords.z, h = heading })
end)

RegisterNUICallback('createBlip', function(data, cb)
    request('dzblip:server:createPoint', { kind = 'blip', data = data }, function(result)
        cb(result or { error = 'unknown' })
    end)
end)

RegisterNUICallback('removeBlip', function(data, cb)
    request('dzblip:server:removePoint', data, function(result) cb(result or 'ok') end)
end)

RegisterNUICallback('createMarker', function(data, cb)
    request('dzblip:server:createPoint', { kind = 'marker', data = data }, function(result)
        cb(result or { error = 'unknown' })
    end)
end)

RegisterNUICallback('removeMarker', function(data, cb)
    request('dzblip:server:removePoint', data, function(result) cb(result or 'ok') end)
end)

RegisterNUICallback('createCheckpoint', function(data, cb)
    request('dzblip:server:createPoint', { kind = 'checkpoint', data = data }, function(result)
        cb(result or { error = 'unknown' })
    end)
end)

RegisterNUICallback('removeCheckpoint', function(data, cb)
    request('dzblip:server:removePoint', data, function(result) cb(result or 'ok') end)
end)

RegisterNUICallback('clearAll', function(_, cb)
    request('dzblip:server:clearAll', nil, function(result) cb(result or 'ok') end)
end)

-- Bundles every point saved on the server into one standalone .lua file
-- (also written to disk as exported_points.lua inside this resource).
RegisterNUICallback('exportSaved', function(_, cb)
    request('dzblip:server:export', nil, function(result)
        cb(result or { error = 'unknown' })
    end)
end)

-- Generate Lua code for the user to copy - purely cosmetic, built from the
-- currently open form only, never touches the server.
RegisterNUICallback('generateCode', function(data, cb)
    local codeLines = {}

    if data.type == 'blip' then
        table.insert(codeLines, "local blip = AddBlipForCoord(" ..
            string.format("%.2f, %.2f, %.2f", data.coords.x, data.coords.y, data.coords.z) .. ")")
        table.insert(codeLines, "SetBlipSprite(blip, " .. data.sprite .. ")")
        table.insert(codeLines, "SetBlipColour(blip, " .. data.color .. ")")
        table.insert(codeLines, "SetBlipScale(blip, " .. (data.scale or 1.0) .. ")")
        table.insert(codeLines, "SetBlipRotation(blip, " .. math.floor(tonumber(data.heading) or 0) .. ")")
        table.insert(codeLines, "SetBlipAsShortRange(blip, true)")
        table.insert(codeLines, "BeginTextCommandSetBlipName('STRING')")
        table.insert(codeLines, "AddTextComponentSubstringPlayerName('" .. (data.label ~= '' and data.label or 'Blip') .. "')")
        table.insert(codeLines, "EndTextCommandSetBlipName(blip)")
    elseif data.type == 'marker' then
        table.insert(codeLines, "DrawMarker(" .. data.markerType .. ",")
        table.insert(codeLines, string.format("    %.2f, %.2f, %.2f,", data.coords.x, data.coords.y, data.coords.z))
        table.insert(codeLines, "    0.0, 0.0, 0.0,")
        table.insert(codeLines, string.format("    0.0, 0.0, %.1f,   -- heading", tonumber(data.heading) or 0.0))
        table.insert(codeLines, string.format("    %.1f, %.1f, %.1f,", data.scaleX or 1.0, data.scaleY or 1.0, data.scaleZ or 1.0))
        table.insert(codeLines, string.format("    %d, %d, %d, %d,", data.r or 255, data.g or 0, data.b or 255, data.a or 150))
        table.insert(codeLines, "    false, false, 2, false, nil, nil, false)")
    else -- checkpoint
        local radius = tonumber(data.radius) or 5.0
        local nx, ny, nz = headingToPointTowards(data.coords.x, data.coords.y, data.coords.z, data.heading, radius)
        table.insert(codeLines, "local checkpoint = CreateCheckpoint(" .. data.checkpointType .. ",")
        table.insert(codeLines, string.format("    %.2f, %.2f, %.2f,   -- position", data.coords.x, data.coords.y, data.coords.z))
        table.insert(codeLines, string.format("    %.2f, %.2f, %.2f,   -- point towards (heading %.0f°)", nx, ny, nz, tonumber(data.heading) or 0))
        table.insert(codeLines, string.format("    %.1f,", radius))
        table.insert(codeLines, string.format("    %d, %d, %d, %d,", data.r or 255, data.g or 0, data.b or 255, data.a or 150))
        table.insert(codeLines, "    0)")
        table.insert(codeLines, string.format("SetCheckpointCylinderHeight(checkpoint, 2.0, 2.0, %.1f) -- required or it won't render", radius))
        table.insert(codeLines, "-- DeleteCheckpoint(checkpoint) when done")
    end

    cb({ code = table.concat(codeLines, '\n') })
end)

-- Called continuously while the user drags a slider/picks an item on the
-- Blips tab. Recreates the local-only preview blip on every call (cheap for
-- blips) so the minimap always reflects the form's current values.
RegisterNUICallback('previewBlip', function(data, cb)
    clearBlipPreview()
    local d = data
    local blip = AddBlipForCoord(d.coords.x + 0.0, d.coords.y + 0.0, d.coords.z + 0.0)
    SetBlipSprite(blip, tonumber(d.sprite) or 1)
    SetBlipColour(blip, tonumber(d.color) or 0)
    SetBlipScale(blip, tonumber(d.scale) or 1.0)
    SetBlipRotation(blip, math.floor(tonumber(d.heading) or 0))
    SetBlipAsShortRange(blip, false)
    BeginTextCommandSetBlipName('STRING')
    AddTextComponentSubstringPlayerName('[PREVIEW] ' .. ((d.label ~= '' and d.label) or (d.typeName or 'Blip')))
    EndTextCommandSetBlipName(blip)
    previewBlipHandle = blip
    cb('ok')
end)

-- Markers just overwrite a table the draw loop below already reads every
-- frame, so this is free of any create/destroy cost - no flicker even while
-- dragging an RGBA slider continuously.
RegisterNUICallback('previewMarker', function(data, cb)
    previewMarkerData = data
    cb('ok')
end)

-- Checkpoints have to be deleted and recreated (no "update in place" native),
-- so the NUI side debounces how often this fires while dragging a slider.
RegisterNUICallback('previewCheckpoint', function(data, cb)
    clearCheckpointPreview()
    local d = data
    local radius = tonumber(d.radius) or 5.0
    local cx, cy, cz = d.coords.x + 0.0, d.coords.y + 0.0, d.coords.z + 0.0
    local r, g, b, a = tonumber(d.r) or 255, tonumber(d.g) or 0, tonumber(d.b) or 255, tonumber(d.a) or 150
    local nx, ny, nz = headingToPointTowards(cx, cy, cz, d.heading, radius)
    local handle = CreateCheckpoint(tonumber(d.checkpointType) or 0, cx, cy, cz, nx, ny, nz, radius, r, g, b, a, 0)
    SetCheckpointCylinderHeight(handle, 2.0, 2.0, radius)
    previewCheckpointHandle = handle
    cb('ok')
end)

-- kind = 'blip' | 'marker' | 'checkpoint' | nil (nil/omitted clears all three)
RegisterNUICallback('clearPreview', function(data, cb)
    local kind = data and data.kind
    if kind == 'blip' then clearBlipPreview()
    elseif kind == 'marker' then clearMarkerPreview()
    elseif kind == 'checkpoint' then clearCheckpointPreview()
    else clearAllPreviews() end
    cb('ok')
end)

-- ============ MARKER DRAW LOOP ============

CreateThread(function()
    while true do
        local wait = 500
        if next(activeMarkers) ~= nil or previewMarkerData ~= nil then
            wait = 0
            for _, entry in pairs(activeMarkers) do
                local d = entry.data
                DrawMarker(
                    tonumber(d.markerType),
                    d.coords.x + 0.0, d.coords.y + 0.0, d.coords.z + 0.0,
                    0.0, 0.0, 0.0,
                    0.0, 0.0, tonumber(d.heading) or 0.0,
                    tonumber(d.scaleX) or 1.0, tonumber(d.scaleY) or 1.0, tonumber(d.scaleZ) or 1.0,
                    tonumber(d.r) or 255, tonumber(d.g) or 0, tonumber(d.b) or 255, tonumber(d.a) or 150,
                    false, false, 2, false, nil, nil, false
                )
            end
            if previewMarkerData then
                local d = previewMarkerData
                DrawMarker(
                    tonumber(d.markerType) or 1,
                    d.coords.x + 0.0, d.coords.y + 0.0, d.coords.z + 0.0,
                    0.0, 0.0, 0.0,
                    0.0, 0.0, tonumber(d.heading) or 0.0,
                    tonumber(d.scaleX) or 1.0, tonumber(d.scaleY) or 1.0, tonumber(d.scaleZ) or 1.0,
                    tonumber(d.r) or 255, tonumber(d.g) or 0, tonumber(d.b) or 255, tonumber(d.a) or 150,
                    false, false, 2, false, nil, nil, false
                )
            end
        end
        Wait(wait)
    end
end)

-- ============ CLEANUP ============
-- Only wipes the natives drawn on THIS client - the server-side saved data
-- is untouched, so everything reloads exactly as it was on the next start.

AddEventHandler('onResourceStop', function(resourceName)
    if GetCurrentResourceName() ~= resourceName then return end
    clearAllLocal()
    clearAllPreviews()
end)
