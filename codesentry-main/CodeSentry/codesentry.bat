@echo off
setlocal

set IMAGE=codesentry:latest
set PROJECT=%~1

if "%PROJECT%"=="" (
    set PROJECT=%CD%
)

shift
set ARGS=
:parse
if "%~1"=="" goto run
set ARGS=%ARGS% %1
shift
goto parse

:run
docker run --rm -v "%PROJECT%:/project" %IMAGE% scan /project %ARGS%
