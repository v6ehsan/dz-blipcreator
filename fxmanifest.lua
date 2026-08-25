fx_version 'cerulean'
game 'gta5'

author 'v6ehsan'
description 'DZ-BlipCreator | Standalone Blip & Marker Dev Tool'
version '1.0.0'

lua54 'yes'

ui_page 'html/index.html'

files {
    'html/index.html',
    'html/style.css',
    'html/script.js',
    'html/img/logo.png'
}

shared_script 'config.lua'
client_script 'client.lua'
server_script 'server.lua'
