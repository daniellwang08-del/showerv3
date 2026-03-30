@echo off
:: Launch all services using production environment (.env.production)
set APP_ENV=production
call "%~dp0start.cmd"
