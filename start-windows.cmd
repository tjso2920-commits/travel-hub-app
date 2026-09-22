@echo off
rem travel hub - 내 PC에서 켜기(Windows). 이 파일을 더블클릭하세요.
rem 끄려면 열린 검은 창에서 Ctrl+C 를 누르거나 창을 닫으세요.
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치돼 있지 않아요. https://nodejs.org 에서 "24 LTS"를 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)
node scripts\start-local.mjs
pause
