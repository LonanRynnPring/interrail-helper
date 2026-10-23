# Interrail Helper

A small, no-install website for planning an Interrail trip.

- **Train Journeys** – add each train (stations, date, times, train number, operator, seat reservation status & cost, whether it uses a pass travel day). Journeys are grouped by day, with totals for travel days used, reservations still to book and time on trains.
- **Planner** – list the cities you want to visit with how many days in each and a start date; get a colour-coded calendar and a map of your route, and turn the legs into train journeys with one click.
- **Overview** – trip dates, pass type, travel-day allowance, spend summary and your route at a glance.
- **Stays** and **Packing** list.

## Saving

Your plan is kept in your browser automatically. Use **Export** to download a `.json` save file, and **Import** to load it again (on any device or browser).

Everything runs locally in the page – nothing is sent to a server.

## Train suggestions

Built for flexible planning: a journey only needs a *from* and *to*. **Suggest trains** (in any journey, or **Find trains** on a planner leg) shows the day's options – times, duration, changes, and a rough guide to whether Interrail needs a seat reservation. If your date is too far ahead for timetables to be published (or you haven't picked one), it shows a **typical day** on the same weekday instead, so you can still see how long a leg takes and how often trains run.

Train data comes from [Transitous](https://transitous.org), a free community-run European journey planner (requests are only made when you click). Places are looked up with [OpenStreetMap Nominatim](https://nominatim.org).

## Licence

MIT
