@echo off
rem travel hub - 내 PC 데이터 백업(Windows). 더블클릭하면 데이터 파일 옆에 날짜가 붙은 복사본을 만듭니다.
chcp 65001 >nul
cd /d "%~dp0"
if "%DB_PATH%"=="" set "DB_PATH=%USERPROFILE%\travelhub\travelhub.db"
node scripts\backup-db.mjs
pause
