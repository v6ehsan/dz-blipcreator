-- ============================================================
-- DZ-BlipCreator - server.lua
-- Everything below is 100% framework-agnostic: no ESX, QB-Core or
-- QBox reference anywhere. It only uses plain FiveM natives, so it
-- runs the same on a standalone server, ESX, QB, QBox, or anything
-- else. This is what turns the tool from "client-only preview" into
-- a real, persistent, multiplayer-synced admin tool:
--   * saved to a JSON file (server-side, survives restarts)
--   * broadcast to every connected player (and anyone who joins later)
--   * gated by FiveM's built-in ACE permission system (Config.Permission)
--   * exportable to a single standalone .lua file for other resources
-- ============================================================

local resourceName = GetCurrentResourceName()
local points = {}      -- [uid] = { uid = 'dzb_1', kind = 'blip'|'marker'|'checkpoint', data = {...} }
local uidCounter = 0

-- ================= STORAGE =================

local function loadPoints()
    local raw = LoadResourceFile(resourceName, Config.Persistence.file)
    if not raw or raw == '' then return end

    local ok, decoded = pcall(json.decode, raw)
    if not ok or type(decoded) ~= 'table' then return end

    points = decoded
    for uid in pairs(points) do
        local n = tonumber(string.match(uid, 'dzb_(%d+)'))
        if n and n > uidCounter then uidCounter = n end
    end
end

local function savePoints()
    SaveResourceFile(resourceName, Config.Persistence.file, json.encode(points), -1)
end

local function nextUid()
    uidCounter = uidCounter + 1
    return 'dzb_' .. uidCounter
end

CreateThread(function()
    loadPoints()
end)

-- ================= PERMISSIONS =================

local function hasPermission(src)
    if Config.AccessMode ~= 'admin' then return true end
    return IsPlayerAceAllowed(src, Config.Permission.ace) == true
end

-- ================= REQUEST/RESPONSE HELPER =================
-- The NUI callbacks in client.lua fire one of these events with a reqId and
-- wait for a single 'dzblip:client:requestResult' reply carrying that same
-- reqId back - a minimal RPC pattern so the client can await a server
-- decision (uid assigned, permission denied, etc).

local function reply(src, reqId, result)
    TriggerClientEvent('dzblip:client:requestResult', src, reqId, result)
end

-- ================= ACCESS CHECK =================
-- Lets the client ask "am I allowed?" BEFORE opening the menu, so in
-- Config.AccessMode = 'admin' a non-admin never even sees the UI instead of
-- opening it and getting rejected on the first action.

RegisterNetEvent('dzblip:server:checkAccess')
AddEventHandler('dzblip:server:checkAccess', function(reqId)
    local src = source
    reply(src, reqId, { allowed = hasPermission(src) })
end)

-- ================= CREATE =================

RegisterNetEvent('dzblip:server:createPoint')
AddEventHandler('dzblip:server:createPoint', function(reqId, payload)
    local src = source
    if not hasPermission(src) then
        reply(src, reqId, { error = 'no_permission' })
        return
    end
    if type(payload) ~= 'table' or type(payload.kind) ~= 'string' or type(payload.data) ~= 'table' then
        reply(src, reqId, { error = 'bad_request' })
        return
    end

    local uid = nextUid()
    local point = { uid = uid, kind = payload.kind, data = payload.data }
    points[uid] = point
    savePoints()

    reply(src, reqId, { uid = uid })
    -- broadcast to EVERY connected client (including the creator), so this
    -- is the single place a blip/marker/checkpoint actually gets drawn
    TriggerClientEvent('dzblip:client:pointCreated', -1, point)
end)

-- ================= REMOVE =================

RegisterNetEvent('dzblip:server:removePoint')
AddEventHandler('dzblip:server:removePoint', function(reqId, payload)
    local src = source
    if not hasPermission(src) then
        reply(src, reqId, { error = 'no_permission' })
        return
    end

    local uid = payload and payload.uid
    if uid and points[uid] then
        points[uid] = nil
        savePoints()
        TriggerClientEvent('dzblip:client:pointRemoved', -1, uid)
    end
    reply(src, reqId, { ok = true })
end)

-- ================= CLEAR ALL =================

RegisterNetEvent('dzblip:server:clearAll')
AddEventHandler('dzblip:server:clearAll', function(reqId)
    local src = source
    if not hasPermission(src) then
        reply(src, reqId, { error = 'no_permission' })
        return
    end

    points = {}
    savePoints()
    TriggerClientEvent('dzblip:client:clearAll', -1)
    reply(src, reqId, { ok = true })
end)

-- ================= SYNC =================
-- Sent to a single client: on resource start and every time that player
-- opens the menu, so a fresh join (or a restart) always shows exactly what
-- every admin has placed so far.

RegisterNetEvent('dzblip:server:requestSync')
AddEventHandler('dzblip:server:requestSync', function()
    local src = source
    local list = {}
    for _, p in pairs(points) do list[#list + 1] = p end
    TriggerClientEvent('dzblip:client:fullSync', src, list)
end)

-- ================= EXPORT =================
-- Bundles every saved point into one plain-native .lua file that has zero
-- dependency on this resource (or any framework) - an owner/dev can lift it
-- straight into their own script.

local function luaStr(s)
    return string.format('%q', tostring(s or ''))
end

-- Mirrors the same conversion done in client.lua: CreateCheckpoint has no
-- direct heading parameter, so a 0-360 heading is turned into the synthetic
-- "point towards" coord that produces that arrow direction (0 = north,
-- clockwise).
local function headingToPointTowards(cx, cy, cz, heading, distance)
    local rad = math.rad(tonumber(heading) or 0.0)
    return cx + math.sin(rad) * distance, cy + math.cos(rad) * distance, cz
end

local function codeForPoint(p)
    local d = p.data
    local lines = {}

    if p.kind == 'blip' then
        lines[#lines + 1] = string.format('do\n    local blip = AddBlipForCoord(%.2f, %.2f, %.2f)',
            d.coords.x, d.coords.y, d.coords.z)
        lines[#lines + 1] = string.format('    SetBlipSprite(blip, %s)', tostring(d.sprite))
        lines[#lines + 1] = string.format('    SetBlipColour(blip, %s)', tostring(d.color))
        lines[#lines + 1] = string.format('    SetBlipScale(blip, %s)', tostring(d.scale or 1.0))
        lines[#lines + 1] = string.format('    SetBlipRotation(blip, %d)', math.floor(tonumber(d.heading) or 0))
        lines[#lines + 1] = '    SetBlipAsShortRange(blip, true)'
        lines[#lines + 1] = "    BeginTextCommandSetBlipName('STRING')"
        lines[#lines + 1] = string.format('    AddTextComponentSubstringPlayerName(%s)',
            luaStr(d.label ~= '' and d.label or d.typeName or 'Blip'))
        lines[#lines + 1] = '    EndTextCommandSetBlipName(blip)'
        lines[#lines + 1] = 'end'
    elseif p.kind == 'marker' then
        lines[#lines + 1] = '-- call this every frame from a loop, e.g.:'
        lines[#lines + 1] = '-- CreateThread(function() while true do <this> Wait(0) end end)'
        lines[#lines + 1] = string.format('DrawMarker(%s,', tostring(d.markerType))
        lines[#lines + 1] = string.format('    %.2f, %.2f, %.2f,', d.coords.x, d.coords.y, d.coords.z)
        lines[#lines + 1] = '    0.0, 0.0, 0.0,'
        lines[#lines + 1] = string.format('    0.0, 0.0, %s,   -- heading', tostring(d.heading or 0.0))
        lines[#lines + 1] = string.format('    %s, %s, %s,',
            tostring(d.scaleX or 1.0), tostring(d.scaleY or 1.0), tostring(d.scaleZ or 1.0))
        lines[#lines + 1] = string.format('    %s, %s, %s, %s,',
            tostring(d.r or 255), tostring(d.g or 0), tostring(d.b or 255), tostring(d.a or 150))
        lines[#lines + 1] = '    false, false, 2, false, nil, nil, false)'
    else -- checkpoint
        local radius = tonumber(d.radius) or 5.0
        local nx, ny, nz = headingToPointTowards(d.coords.x, d.coords.y, d.coords.z, d.heading, radius)
        lines[#lines + 1] = string.format('local checkpoint = CreateCheckpoint(%s,', tostring(d.checkpointType))
        lines[#lines + 1] = string.format('    %.2f, %.2f, %.2f,   -- position', d.coords.x, d.coords.y, d.coords.z)
        lines[#lines + 1] = string.format('    %.2f, %.2f, %.2f,   -- point towards (heading %s°)',
            nx, ny, nz, tostring(d.heading or 0))
        lines[#lines + 1] = string.format('    %.1f,', radius)
        lines[#lines + 1] = string.format('    %s, %s, %s, %s,',
            tostring(d.r or 255), tostring(d.g or 0), tostring(d.b or 255), tostring(d.a or 150))
        lines[#lines + 1] = '    0)'
        lines[#lines + 1] = string.format('SetCheckpointCylinderHeight(checkpoint, 2.0, 2.0, %.1f) -- required or it won\'t render', radius)
        lines[#lines + 1] = '-- DeleteCheckpoint(checkpoint) when done'
    end

    return table.concat(lines, '\n')
end

RegisterNetEvent('dzblip:server:export')
AddEventHandler('dzblip:server:export', function(reqId)
    local src = source
    if not hasPermission(src) then
        reply(src, reqId, { error = 'no_permission' })
        return
    end

    local ordered = {}
    for _, p in pairs(points) do ordered[#ordered + 1] = p end
    table.sort(ordered, function(a, b) return a.uid < b.uid end)

    if #ordered == 0 then
        reply(src, reqId, { error = 'empty' })
        return
    end

    local out = {
        '-- Auto-generated by DZ-BlipCreator',
        '-- Standalone: no ESX / QB-Core / QBox dependency, plain natives only.',
        '-- Paste this into any client-side script and every blip/marker/',
        '-- checkpoint below will be recreated exactly where it was placed.',
        ''
    }
    for _, p in ipairs(ordered) do
        out[#out + 1] = codeForPoint(p)
        out[#out + 1] = ''
    end
    local code = table.concat(out, '\n')

    local relativePath = 'exported_points.lua'
    SaveResourceFile(resourceName, relativePath, code, -1)

    local fullPath = GetResourcePath(resourceName) .. relativePath

    reply(src, reqId, { code = code, path = fullPath, count = #ordered })
end)
