# Arma 3 SQF Debugger

This extension allows you to debug your scripts directly, as they are running in Arma 3.  
To do this it uses the Arma Debug Engine (by Dedmen).  

It is only tested (lightly, so far) for debugging of mission scripts when run via the Eden editor, other 
scenarios are not tested.  

To work it needs to correctly map the ingame script paths to your on-disk script paths. The `missionRoot`
and `scriptPrefix` in the `launch.json` are what determine this mapping. The default should be correct if you follow the 
instructions below.  

This extension is based on unfinished implementation by SkaceKamen in [SQF Lint](https://github.com/SkaceKamen/vscode-sqflint/tree/feature-armadebug).

## Requires

- [Arma Debug Engine](https://steamcommunity.com/sharedfiles/filedetails/?id=1585582292) Arma 3 mod
- [SQF Language](https://marketplace.visualstudio.com/items?itemName=Armitxes.sqf) Visual Studio Code extension

## Instructions

1. Install and activate the Arma Debug Engine and pre-requisite mods
2. Run a mission you want to debug via the Eden editor
3. Open the mission script directory in VSCode
4. Press F5 (or run via the Debug sidebar)
5. A new default launch configuration should be created automatically for you
6. Place breakpoints in your code to debug it at those locations

## Known Issues

- Sometimes scopes won't resolve -- restart debugging to fix
- Breakpoints aren't validated -- if they don't match a real instruction in Arma they will just not fire
- In some cases breakpoints won't be on the correct line (see Trouble Shooting)

## Not Implemented

- Watches
- Expression evaluation (hover, debug console)
- Threads
- Pause
- Source code from game

## Trouble Shooting

Enable logging in SQF Debugger configuration settings (might need to restart VSCode for it to apply).  

Check the Debug Console output in VSCode for errors.  

If breakpoints are not being hit:
- Confirm (in the Debug Console) that paths are being mapped between your workspace and the game correctly. If not then adjust the `missionRoot` (your workspace) and `scriptPrefix` (in game) paths in your `.vscode/launch.json` file (click the cog on the Debug sidebar).  
- Confirm that your source file doesn't not begin with a block comment before `#include` statements, as this will break
line numbering totally.  
- Try adding more breakpoints around the line you are trying to hit.  

If the server won't connect: 
- Double check Arma Debug Engine is enabled and on the latest version. Seeing a warning dialog on start up is a dead giveaway that it is loading correctly. Check your intercept_dll.log at `C:\Program Files (x86)\Steam\steamapps\common\Arma 3\Logs\intercept_dll.log`.  
- Restart both VSCode and Arma 3.
