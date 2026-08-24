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
| `POST` | `/api/analyze` | `multipart/form-data`: `file`, `profile` (`mixed\|driving\|cycling\|walking`) |
| `POST` | `/api/apply` | JSON: `track_id`, `selections` (`anomaly_id → option_id`), `export_format` |
| `GET` | `/api/download/{track_id}?format=gpx\|kml` | Скачать результат |

### Пример

```bash
curl -s -F file=@samples/broken_track.gpx -F profile=mixed \
  http://localhost:8000/api/analyze | jq '.summary'
```

## Как это устроено

1. **Parse** — GPX / KML / FIT → единый список точек
2. **Detect** — эвристики: time/distance gap, невозможная скорость, зигзаги
3. **Propose** — для каждой аномалии:
   - локально: keep / interpolate / discard
   - Mapbox Directions: заполнить разрыв маршрутом (по профилям)
   - Mapbox Map Matching: притянуть окно точек к дорогам
4. **Apply** — пользователь выбирает вариант → экспорт GPX/KML

Профиль `mixed` запрашивает варианты для `driving`, `cycling` и `walking`.

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
