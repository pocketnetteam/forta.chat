# Desktop smoke checklist (Phase 0–2)

Ручная проверка на Windows (основная машина команды). Цель: убедиться, что baseline Electron стабилен до packaging / UX / updates.

## Подъём за <15 минут

```bash
npm ci
npm run electron:dev
```

Опционально без HMR:

```bash
npm run electron:preview
```

## Smoke scenarios

| # | Сценарий | Ожидание | ☐ |
|---|----------|----------|---|
| 1 | Старт `electron:dev` | Окно без белого flash, TitleBar виден, DevTools открыты | ☐ |
| 2 | Логин | Список комнат появляется, sync без зависания | ☐ |
| 3 | Отправка текста | Сообщение уходит и отображается в ленте | ☐ |
| 4 | Файл (скачать вложение) | Native save dialog → файл сохраняется и открывается | ☐ |
| 5 | Звонок (mic) | Permission prompt / звонок стартует без краша | ☐ |
| 6 | Tor toggle Never → Auto → Always | Статус в TitleBar меняется; нет зависания UI | ☐ |
| 7 | Single instance | Второй запуск фокусирует первое окно, не создаёт второе | ☐ |
| 8 | External link | Ссылка открывается в системном браузере | ☐ |
| 9 | Close → tray | Закрытие окна прячет в трей; Quit из меню трея завершает app | ☐ |
| 10 | Deep link | `forta://join?room=…` / `forta://room/…` открывает комнату (cold + warm) | ☐ |
| 11 | Notification click | Клик по баннеру фокусирует окно и открывает чат | ☐ |
| 12 | Desktop settings | Close to tray / Open at login сохраняются | ☐ |
| 13 | Zoom | Ctrl/Cmd + − 0 меняет масштаб | ☐ |

## Автопроверки (обязательны перед коммитом)

```bash
npm run build
npm run lint
npx vue-tsc --noEmit
npm run test
```

## Ссылки

- План фаз: [electron-desktop-integration-plan.md](./electron-desktop-integration-plan.md)
- Packaging: [packaging-checklist.md](./packaging-checklist.md)
