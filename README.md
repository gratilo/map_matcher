# TrackFix — GPS track repair service

Сервис принимает битый GPS-трек (GPX / KML / FIT), находит аномалии
(разрывы, скачки, шум) и предлагает варианты исправления на основе
**Mapbox Map Matching** и **Directions**. Есть REST API и простой веб-UI.

## Быстрый старт

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# впишите MAPBOX_ACCESS_TOKEN в .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Откройте http://localhost:8000

Без токена Mapbox анализ и локальные варианты (интерполяция / удаление / оставить)
работают; snap к дорогам и построение маршрута через разрыв — нет.

## API

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/api/health` | Статус и наличие Mapbox-токена |
| `POST` | `/api/analyze` | Загрузка файла: парсинг + подсказки разрывов (без авто-маршрутов) |
| `POST` | `/api/connect` | JSON: `track_id`, `start_index`, `end_index`, `profile` → варианты Mapbox Directions |
| `POST` | `/api/apply` | JSON: `track_id`, `selections` (`connect_id → option_id`), `export_format` |
| `GET` | `/api/download/{track_id}?format=gpx\|kml` | Скачать результат |

### Пример

```bash
curl -s -F file=@samples/broken_track.gpx -F profile=mixed \
  http://localhost:8000/api/analyze | jq '.summary'
```

## Как это устроено

1. **Загрузка** — GPX / KML / FIT на карту. Разрывы **не** рисуются сплошной прямой: сегменты обрываются, пунктир — только подсказка «здесь дыра в файле».
2. **Выбор A и B** — клик по треку (или кнопка-подсказка разрыва): точка разрыва и точка соединения.
3. **Маршруты** — `POST /api/connect` дергает Mapbox Directions между A и B (профили + альтернативы).
4. **Выбор и применение** — на карте видны варианты по дорогам; выбранный вставляется вместо участка A…B.

Прямая линия в списке вариантов — только для сравнения (`interpolate`), это не map matching.

## Структура

```
backend/app/          FastAPI приложение
  parsers/            GPX, KML, FIT
  analysis/           детектор аномалий
  matching/           клиент Mapbox
  repair/             генерация и применение фиксов
frontend/             веб-UI (Leaflet + OSM tiles)
samples/              примеры треков
tests/                unit-тесты
```

## Ограничения MVP

- FIT: только записи с GPS; экспорт FIT пока не поддерживается
- KMZ не поддерживается (распакуйте в KML)
- Map Matching: чанки до ~95 точек (лимит Mapbox — 100)
- Сессии анализа хранятся в памяти ~1 час
- Смешанный режим не сегментирует трек по типу активности автоматически —
  предлагает альтернативы по нескольким профилям

## Токен Mapbox

Нужен токен с доступом к Map Matching API и Directions API:
https://account.mapbox.com/
