import random
import sqlite3
import sys
import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime
from logging import Logger
from pathlib import Path
from typing import Any, ClassVar, Hashable, List
from uuid import uuid4

import humanize
import inflect
import rich
import schedule  # type: ignore
from playwright.sync_api import Browser, Playwright, sync_playwright
from rich.pretty import pretty_repr
from rich.prompt import Prompt

from .ai import AIBackend, AIResponse, AIUnavailableError, general_assessment_config
from .config import Config, supported_ai_backends, supported_marketplaces
from .image_matching import ImageMatcher
from .listing import Listing
from .marketplace import ItemConfig, Marketplace, TItemConfig, TMarketplaceConfig
from .matches import (
    has_match,
    load_matches,
    rating_fields,
    record_failed_rating,
    record_manual_listing,
    record_match,
    record_recheck,
    record_sighting,
)
from .notification import NotificationStatus
from .photos import archive_next_photo
from .recheck import RecheckQueue, price_filter_reason
from .user import User
from .utils import (
    CounterItem,
    KeyboardMonitor,
    SleepStatus,
    Translator,
    aimm_event,
    amm_home,
    cache,
    calculate_file_hash,
    counter,
    doze,
    hilight,
)


class MarketplaceMonitor:
    active_marketplaces: ClassVar[dict[str, Any]] = {}

    def __init__(
        self: "MarketplaceMonitor",
        config_files: List[Path] | None,
        headless: bool | None,
        logger: Logger | None,
    ) -> None:
        for file_path in config_files or []:
            if not file_path.exists():
                raise FileNotFoundError(f"Config file {file_path} not found.")
        default_config = amm_home / "config.toml"
        self.config_files = ([default_config] if default_config.exists() else []) + (
            [x.expanduser().resolve() for x in config_files or []]
        )
        #
        self.config: Config | None = None
        self.config_hash: str | None = None
        self.headless = headless
        # When True, start_monitor blocks until every enabled marketplace
        # has a username + password in the config. The web UI sets this
        # so Playwright doesn't race the web UI for Facebook credentials.
        self.defer_login_until_credentials: bool = False
        self.ai_agents: List[AIBackend] = []
        self.keyboard_monitor: KeyboardMonitor | None = None
        self.playwright: Playwright = sync_playwright().start()
        self.browser: Browser | None = None
        self.logger = logger
        self.search_requested = threading.Event()
        self.search_cancelled = threading.Event()
        self.requested_item_searches: set[str] = set()
        self.requested_item_searches_lock = threading.Lock()
        self.search_progress: dict[str, Any] = {}
        self.rechecks = RecheckQueue()
        self.image_matcher = ImageMatcher(cache)
        self.image_matcher.queue.wake = self.rechecks.wake
        self.recheck_after = 0.0
        self.photo_attempts: set[tuple[str, str, str]] = set()

    def request_search(self: "MarketplaceMonitor") -> None:
        """Ask the monitor thread to run every enabled search at its next safe point."""
        self.search_requested.set()

    def request_item_search(self: "MarketplaceMonitor", item: str) -> None:
        """Ask the monitor thread to run one saved search at its next safe point."""
        with self.requested_item_searches_lock:
            self.requested_item_searches.add(item)
        self.rechecks.wake.set()

    def run_requested_item_search(self: "MarketplaceMonitor") -> bool:
        """Run one requested saved search; its interval restarts from now."""
        with self.requested_item_searches_lock:
            if not self.requested_item_searches:
                return False
            item = self.requested_item_searches.pop()
        jobs = schedule.get_jobs(item)
        if jobs:
            jobs[0].run()
        elif self.logger:
            self.logger.warning(
                f"""{hilight("[Search]", "fail")} {item} is paused or no longer configured, so it was not searched."""
            )
        return True

    def progress_snapshot(self: "MarketplaceMonitor") -> dict[str, Any]:
        """Listing counts for the running search, read by the web UI thread."""
        return {**self.search_progress, "cancelling": self.search_cancelled.is_set()}

    def cancel_search(self: "MarketplaceMonitor") -> None:
        """Stop the running search at its next listing and skip the rest of a requested run."""
        self.search_requested.clear()
        with self.requested_item_searches_lock:
            self.requested_item_searches.clear()
        self.search_cancelled.set()

    def load_config_file(self: "MarketplaceMonitor") -> Config:
        """Load the configuration file."""
        last_invalid_hash = None
        while True:
            new_file_hash = calculate_file_hash(self.config_files)
            config_changed = self.config_hash is None or new_file_hash != self.config_hash
            if not config_changed:
                assert self.config is not None
                return self.config
            try:
                # if the config file is ok, break
                assert self.logger is not None
                self.config = Config(self.config_files, self.logger)
                self.image_matcher.configure(self.config)
                self.config_hash = new_file_hash
                # self.logger.debug(self.config)
                assert self.config is not None
                return self.config
            except KeyboardInterrupt:
                raise
            except Exception as e:
                if last_invalid_hash != new_file_hash:
                    last_invalid_hash = new_file_hash
                    if self.logger:
                        self.logger.error(
                            f"""{hilight("[Config]", "fail")} Error parsing:\n\n{hilight(str(e), "fail")}\n\nPlease fix the configuration and I will try again as soon as you are done."""
                        )
                doze(60, self.config_files, self.keyboard_monitor)
                continue

    def _launch_browser(self: "MarketplaceMonitor") -> Browser:
        """Launch a browser, preferring Chromium if available, otherwise any installed browser."""
        # Try browsers in order of preference
        browser_types = [
            ("chromium", self.playwright.chromium),
            ("firefox", self.playwright.firefox),
            ("webkit", self.playwright.webkit),
        ]

        for browser_name, browser_type in browser_types:
            try:
                if self.logger:
                    self.logger.debug(f"Attempting to launch {browser_name} browser...")
                browser = browser_type.launch(headless=self.headless)
                if self.logger:
                    self.logger.info(
                        f"""{hilight("[Browser]", "info")} Successfully launched {browser_name} browser.""",
                        extra=aimm_event("browser_ready", engine=browser_name),
                    )
                return browser
            except Exception as e:
                if self.logger:
                    self.logger.debug(f"Failed to launch {browser_name}: {e}")
                continue

        # If all fail, raise an error
        raise RuntimeError(
            "No browser could be launched. Please ensure Chromium, Firefox, or WebKit is installed."
        )

    def load_ai_agents(self: "MarketplaceMonitor") -> None:
        """Load the AI agent."""
        assert self.config is not None
        self.ai_agents.clear()
        for ai_config in (self.config.ai or {}).values():
            if ai_config.enabled is False:
                continue
            if (
                ai_config.provider is not None
                and ai_config.provider.lower() in supported_ai_backends
            ):
                ai_class = supported_ai_backends[ai_config.provider.lower()]
            elif ai_config.name.lower() in supported_ai_backends:
                ai_class = supported_ai_backends[ai_config.name.lower()]
            else:
                if self.logger:
                    self.logger.error(
                        f"""{hilight("[Config]", "fail")} Cannot determine an AI service provider from service name or provider."""
                    )
                continue

            try:
                self.ai_agents.append(ai_class(config=ai_config, logger=self.logger))
                # self.ai_agents[-1].connect()
                # self.logger.info(
                #     f"""{hilight("[AI]", "succ")} Connected to {hilight(ai_config.name)}"""
                # )
            except KeyboardInterrupt:
                raise
            except Exception as e:
                if self.logger:
                    self.logger.error(
                        f"""{hilight("[AI]", "fail")} Failed to connect to {hilight(ai_config.name, "fail")}: {e}"""
                    )
                continue

    def chat_backend(self: "MarketplaceMonitor", item: str) -> tuple[AIBackend, ItemConfig | None]:
        """Pick the AI that rates this search; a new instance keeps web chats off the monitor's client."""
        if self.config is None:
            raise ValueError("The monitor has not loaded its configuration yet.")
        item_config = self.config.item.get(item)
        marketplace_config = self.config.marketplace.get(
            (item_config.marketplace if item_config else None)
            or next(iter(self.config.marketplace), "")
        )
        if item_config is not None and item_config.ai is not None:
            names = item_config.ai
        elif marketplace_config is not None:
            names = marketplace_config.ai
        else:
            names = None
        for agent in list(self.ai_agents):
            if names is None or agent.config.name in names:
                return type(agent)(config=agent.config, logger=self.logger), item_config
        raise ValueError("No enabled AI service is configured for this search.")

    def search_item(
        self: "MarketplaceMonitor",
        marketplace_config: TMarketplaceConfig,
        marketplace: Marketplace,
        item_config: TItemConfig,
    ) -> None:
        """Search for an item on the marketplace."""
        new_listings: List[Listing] = []
        listing_ratings = []
        # users to notify is determined from item, then marketplace, then all users
        assert self.config is not None
        users_to_notify = (
            item_config.notify or marketplace_config.notify or list(self.config.user.keys())
        )
        run = uuid4().hex
        self.search_cancelled.clear()
        progress: dict[str, Any] = {
            "item": item_config.name,
            "done": 0,
            "total": None,
            "rating": 0,
            "checked": 0,
            "browsing": True,
        }
        self.search_progress = progress
        if self.logger:
            self.logger.info(
                f"""{hilight("[Search]", "info")} Searching for {item_config.name}.""",
                extra=aimm_event(
                    "search_started", item=item_config.name, marketplace=marketplace_config.name
                ),
            )

        def observe(listing: Listing) -> None:
            try:
                seen_again = record_sighting(cache, listing, item_config.name, run)
            except sqlite3.OperationalError as error:
                # A missed sighting is cheaper than stopping the whole monitor.
                if self.logger:
                    self.logger.warning(f"Could not record sighting of {listing.title}: {error}")
                return
            if seen_again and self.logger:
                self.logger.info(
                    "Known match seen again: %s",
                    listing.title,
                    extra=aimm_event(
                        "match_seen",
                        item=item_config.name,
                        marketplace=listing.marketplace,
                        listing_id=listing.id,
                    ),
                )

        def results_loaded(count: int) -> None:
            progress.update(done=0, total=count)

        def opened(listing: Listing) -> None:
            progress["done"] += 1
            progress["checked"] += 1
            observe(listing)

        def apply_rating(listing: Listing, rating: Future[AIResponse]) -> None:
            try:
                res = rating.result()
            except AIUnavailableError:
                if self.logger:
                    self.logger.warning(
                        f"""{hilight("[AI]", "fail")} No configured AI evaluated {hilight(listing.title)}. Skipped until a later search."""
                    )
                return
            if self.logger:
                if res.comment == AIResponse.NOT_EVALUATED:
                    if res.name:
                        self.logger.info(
                            f"""{hilight("[AI]", res.style)} {res.name or "AI"} did not evaluate {hilight(listing.title)}."""
                        )
                    else:
                        self.logger.info(
                            f"""{hilight("[AI]", res.style)} No AI available to evaluate {hilight(listing.title)}."""
                        )
                else:
                    self.logger.info(
                        f"""{hilight("[AI]", res.style)} {res.name or "AI"} concludes {hilight(f"{res.conclusion} ({res.score}): {res.comment}", res.style)} for listing {hilight(listing.title)}.""",
                        extra=aimm_event(
                            "ai_eval",
                            listing_id=listing.id,
                            title=listing.title,
                            url=getattr(listing, "post_url", None)
                            or getattr(listing, "url", None),
                            price=getattr(listing, "price", None),
                            score=res.score,
                            conclusion=res.conclusion,
                            comment=res.comment,
                            ai_name=res.name,
                            item=item_config.name,
                        ),
                    )
            if item_config.rating:
                acceptable_rating = item_config.rating[
                    0 if item_config.searched_count == 0 else -1
                ]
            elif marketplace_config.rating:
                acceptable_rating = marketplace_config.rating[
                    0 if item_config.searched_count == 0 else -1
                ]
            else:
                acceptable_rating = 3

            if res.score < acceptable_rating:
                record_failed_rating(cache, listing, item_config.name, res)
                if self.logger:
                    self.logger.info(
                        f"""{hilight("[Skip]", "fail")} Rating {hilight(f"{res.conclusion} ({res.score})")} for {listing.title} is below threshold {acceptable_rating}.""",
                        extra=aimm_event(
                            "listing_skip",
                            reason="below_threshold",
                            listing_id=listing.id,
                            title=listing.title,
                            item=item_config.name,
                            score=res.score,
                            threshold=acceptable_rating,
                        ),
                    )
                counter.increment(CounterItem.EXCLUDED_LISTING, item_config.name)
                return
            new_listings.append(listing)
            listing_ratings.append(res)
            is_new = record_match(cache, listing, item_config.name, res, run=run)
            if self.logger and is_new:
                self.logger.info(
                    "Match saved: %s",
                    listing.title,
                    extra=aimm_event(
                        "match_recorded",
                        item=item_config.name,
                        marketplace=listing.marketplace,
                        listing_id=listing.id,
                        title=listing.title,
                        price=listing.price,
                        score=rating_fields(res)["score"],
                    ),
                )

        # AI calls overlap the browser opening the next listing; results are applied here,
        # in listing order, so match records and notifications stay on the monitor thread.
        queued_ids: set[str] = set()
        pending: deque[tuple[Listing, Future[AIResponse]]] = deque()
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="aimm-ai") as ai_worker:
            for listing in marketplace.search(
                item_config,
                on_listing=opened,
                should_stop=self.search_cancelled.is_set,
                on_results=results_loaded,
            ):
                while pending and pending[0][1].done():
                    rated_listing, rating = pending.popleft()
                    apply_rating(rated_listing, rating)
                progress["rating"] = len(pending)
                observe(listing)
                # Exact IDs define identity; similarly worded reposts remain separate listings.
                if listing.id in queued_ids:
                    if self.logger:
                        self.logger.debug(f"Found duplicated result for {listing}")
                    continue
                # if everyone has been notified
                if (
                    users_to_notify
                    and has_match(cache, listing.marketplace, listing.id, item_config.name)
                    and all(
                        User(self.config.user[user], self.logger).notification_status(listing)
                        == NotificationStatus.NOTIFIED
                        for user in users_to_notify
                    )
                ):
                    if self.logger:
                        self.logger.info(
                            f"""{hilight("[Skip]", "info")} Already sent notification for item {hilight(listing.title)}, skipping.""",
                            extra=aimm_event(
                                "listing_skip",
                                reason="already_notified",
                                listing_id=listing.id,
                                title=listing.title,
                                item=item_config.name,
                            ),
                        )
                    continue
                queued_ids.add(listing.id)
                pending.append(
                    (
                        listing,
                        ai_worker.submit(
                            self.evaluate_by_ai,
                            listing,
                            item_config=item_config,
                            marketplace_config=marketplace_config,
                        ),
                    )
                )
            progress["browsing"] = False
            if self.search_cancelled.is_set():
                for _, rating in pending:
                    rating.cancel()
            while pending:
                progress["rating"] = len(pending)
                rated_listing, rating = pending.popleft()
                if not rating.cancelled():
                    apply_rating(rated_listing, rating)

        self.search_progress = {}
        p = inflect.engine()
        cancelled = self.search_cancelled.is_set()
        if self.logger:
            self.logger.info(
                f"""{hilight("[Search]", "succ" if len(new_listings) > 0 else "fail")} {hilight(str(len(new_listings)))} new {p.plural_noun("listing", len(new_listings))} for {item_config.name} {p.plural_verb("is", len(new_listings))} found{" before the search was cancelled" if cancelled else ""}.""",
                extra=aimm_event(
                    "search_summary",
                    item=item_config.name,
                    marketplace=marketplace_config.name,
                    new_count=len(new_listings),
                    cancelled=cancelled,
                    checked=progress["checked"],
                ),
            )
        if new_listings:
            counter.increment(
                CounterItem.NEW_VALIDATED_LISTING, item_config.name, len(new_listings)
            )
            for user in users_to_notify:
                User(self.config.user[user], logger=self.logger).notify(
                    new_listings, listing_ratings, item_config
                )
        time.sleep(5)

    def _select_translator(
        self: "MarketplaceMonitor", language: str | None = None
    ) -> Translator | None:
        """Select the language for the marketplace."""
        # self.config.translator.get(marketplace_config.language, None)
        assert self.config is not None
        if not language:
            return None
        if language in self.config.translator:
            return self.config.translator[language]
        # if there is no exact match, we are going to match the language code
        # e.g. 'en' to 'en_US'
        if "_" in language:
            # if a more general languge exists?
            if language.split("_")[0] in self.config.translator:
                translator = self.config.translator[language.split("_")[0]]
                if self.logger:
                    self.logger.info(
                        f"""{hilight("[Translator]", "info")} Using language {language.split("_")[0]} (locale {translator.locale}) for {language} translation."""
                    )
                return translator
            # if not, we are going to match the language code
            # e.g. 'en' to 'en_US'
            for name, translator in self.config.translator.items():
                if name.startswith(language.split("_")[0] + "_"):
                    if self.logger:
                        self.logger.info(
                            f"""{hilight("[Translator]", "info")} Using language {name} (locale {translator.locale}) for {language} translation."""
                        )
                    return translator
        # if there is no match, we are going to match the language code
        # e.g. 'en' to 'en_US'
        for name, translator in self.config.translator.items():
            if name.startswith(language + "_"):
                if self.logger:
                    self.logger.info(
                        f"""{hilight("[Translator]", "info")} Using language {name} (locale {translator.locale}) for {language} translation."""
                    )
                return translator
        raise RuntimeError(f"Cannot find translator for language {language}.")

    def schedule_jobs(self: "MarketplaceMonitor") -> None:
        """Schedule jobs to run periodically."""
        # we reload the config file each time when a scan action is completed
        # this allows users to add/remove products dynamically.
        self.load_config_file()
        self.load_ai_agents()

        assert self.config is not None
        for marketplace_config in self.config.marketplace.values():
            if marketplace_config.enabled is False:
                continue
            marketplace_class = supported_marketplaces[
                marketplace_config.market_type or "facebook"
            ]
            if marketplace_config.name in self.active_marketplaces:
                marketplace = self.active_marketplaces[marketplace_config.name]
            else:
                marketplace = marketplace_class(
                    marketplace_config.name, self.browser, self.keyboard_monitor, self.logger
                )
                self.active_marketplaces[marketplace_config.name] = marketplace

            # Configure might have been changed
            marketplace.configure(
                marketplace_config,
                translator=self._select_translator(marketplace_config.language),
            )

            for item_config in self.config.item.values():
                if item_config.enabled is False:
                    continue

                if (
                    item_config.marketplace is None
                    or item_config.marketplace == marketplace_config.name
                ):
                    # wait for some time before next search
                    # interval (in minutes) can be defined both for the marketplace
                    # if there is any configuration file change, stop sleeping and search again
                    scheduled_jobs = []
                    scheduled = None
                    start_at_list = item_config.start_at or marketplace_config.start_at
                    if start_at_list is not None and start_at_list:
                        for start_at in start_at_list:
                            if start_at.startswith("*:*:"):
                                # '*:*:12' to ':12'
                                if self.logger:
                                    self.logger.info(
                                        f"""{hilight("[Schedule]", "info")} Scheduling to search for {item_config.name} every minute at {start_at[3:]}s"""
                                    )
                                scheduled = schedule.every().minute.at(start_at[3:])
                            elif start_at.startswith("*:"):
                                # '*:12:12' or  '*:12'
                                if self.logger:
                                    self.logger.info(
                                        f"""{hilight("[Schedule]", "info")} Scheduling to search for {item_config.name} every hour at {start_at[1:]}m"""
                                    )
                                scheduled = schedule.every().hour.at(
                                    start_at[1:] if start_at.count(":") == 1 else start_at[2:]
                                )
                            else:
                                # '12:12:12' or '12:12'
                                if self.logger:
                                    self.logger.info(
                                        f"""{hilight("[Schedule]", "ss")} Scheduling to search for {item_config.name} every day at {start_at}"""
                                    )
                                scheduled = schedule.every().day.at(start_at)
                            scheduled_jobs.append(scheduled)
                    else:
                        search_interval = max(
                            item_config.search_interval
                            or marketplace_config.search_interval
                            or 30 * 60,
                            1,
                        )
                        max_search_interval = max(
                            item_config.max_search_interval
                            or marketplace_config.max_search_interval
                            or 60 * 60,
                            search_interval,
                        )
                        if self.logger:
                            self.logger.info(
                                f"""{hilight("[Schedule]", "info")} Scheduling to search for {item_config.name} every {humanize.naturaldelta(search_interval)} {"" if search_interval == max_search_interval else f"to {humanize.naturaldelta(max_search_interval)}"}"""
                            )
                        scheduled = schedule.every(search_interval).to(max_search_interval).seconds
                    if scheduled is None:
                        raise ValueError(
                            f"Cannot determine a schedule for {item_config.name} from configuration file."
                        )
                    for job in scheduled_jobs or [scheduled]:
                        job.do(
                            self.search_item,
                            marketplace_config,
                            marketplace,
                            item_config,
                        ).tag(item_config.name)

    def handle_pause(self: "MarketplaceMonitor") -> None:
        """Handle interruption signal."""
        if self.keyboard_monitor is None or not self.keyboard_monitor.is_paused():
            return

        rich.print(counter)
        if not self.keyboard_monitor.confirm():
            return

        # now we should go to an interactive session
        while True:
            while True:
                url = (
                    Prompt.ask(
                        f"""\nEnter an {hilight("ID")} or a {hilight("URL")} to check, or {hilight("exit")}."""
                    )
                    .strip("\x1b")
                    .strip()
                )

                if not url.isnumeric() and not url.startswith("https://"):
                    if url.endswith("exit"):
                        url = "exit"
                        break
                    if url:
                        print(f'Invalid input "{url}". Please try again.')
                else:
                    break

            if url == "exit":
                break

            try:
                self.check_items([url], for_item=None)
            except KeyboardInterrupt:
                raise
            except Exception as e:
                if self.logger:
                    self.logger.debug(f"Failed to check item {url}: {e}")

    def _has_marketplace_credentials(self: "MarketplaceMonitor") -> bool:
        """True if every enabled marketplace has a username and password.

        Used to defer launching the Playwright browser until the user has
        provided credentials (typically via the web UI), to avoid the
        confusing state of two places asking for Facebook login at once.
        """
        assert self.config is not None
        for mp in self.config.marketplace.values():
            if getattr(mp, "enabled", True) is False:
                continue
            if not getattr(mp, "username", None) or not getattr(mp, "password", None):
                return False
        return True

    def _wait_for_marketplace_credentials(self: "MarketplaceMonitor") -> None:
        """Block until config has marketplace credentials.

        Reloads the config whenever the file changes on disk.
        No-op if credentials are already present.
        """
        assert self.config is not None
        while not self._has_marketplace_credentials():
            if self.logger:
                self.logger.info(
                    f"""{hilight("[Login]", "info")} Waiting for Facebook credentials. Sign in via the web UI or add username/password under [marketplace.facebook] in your config. The Playwright browser will launch once credentials are available.""",
                    extra=aimm_event("credentials_wait", status="waiting"),
                )
            # doze wakes up on file change OR keyboard interrupt OR timeout.
            doze(300, self.config_files, self.keyboard_monitor)
            # File may have changed — reload the config (non-fatal on parse error).
            try:
                self.load_config_file()
            except KeyboardInterrupt:
                raise
            except Exception as e:
                if self.logger:
                    self.logger.debug(f"Config reload failed during credential wait: {e}")
                continue
        if self.logger:
            self.logger.info(
                f"""{hilight("[Login]", "succ")} Facebook credentials found — launching browser.""",
                extra=aimm_event("credentials_wait", status="found"),
            )

    def start_monitor(self: "MarketplaceMonitor") -> None:
        """Main function to monitor the marketplace."""
        # start a browser with playwright, cannot use with statement since the jobs will be
        # executed outside of the scope by schedule job runner
        self.keyboard_monitor = KeyboardMonitor()
        self.keyboard_monitor.start()

        # Open a new browser page.
        self.load_config_file()
        assert self.config is not None
        # If requested (by the web UI), defer browser launch until
        # marketplace credentials are set. Without this, Playwright
        # navigates to the Facebook login page and waits for manual
        # input even though the user has a web UI open that's also
        # asking for those same credentials.
        if self.defer_login_until_credentials:
            self._wait_for_marketplace_credentials()
        self.browser = self._launch_browser()
        #
        assert self.browser is not None
        while True:
            self.handle_pause()
            self.schedule_jobs()
            if not schedule.get_jobs():
                # this actually should not happen because at least one item is required for the configuration file
                if self.logger:
                    self.logger.error(
                        "No search job is defined. Please add search items to your config file."
                    )
                self.handle_pause()
                if doze(60, self.config_files, self.keyboard_monitor) == SleepStatus.BY_KEYBOARD:
                    self.keyboard_monitor.set_paused(True)
                continue
            # run all jobs at the first time, then on their own schedule
            # we could have used schedule.run_all() but we would like to check if
            # configuration file has been changed, if so, clear all jobs and restart
            searched_items: set[Hashable] = set()
            for job in schedule.get_jobs():
                if job.tags & searched_items:
                    continue
                searched_items.update(job.tags)
                job.run()
                self.handle_pause()
                if self.reload_requested() or self.search_cancelled.is_set():
                    break
            if not schedule.get_jobs():
                continue
            # subsequent runs will be scheduled runs
            while True:
                next_job: schedule.Job | None = None
                for job in schedule.jobs:
                    if job.next_run is None:
                        continue
                    if next_job is None or (
                        next_job.next_run and next_job.next_run > job.next_run
                    ):
                        next_job = job

                if next_job is None:
                    # no more job
                    if self.logger:
                        self.logger.warning(
                            f"""{hilight("[Schedule]", "fail")} No more active search job."""
                        )
                    sys.exit(0)
                # assert next_job is not None
                assert next_job.next_run is not None
                idle_seconds = schedule.idle_seconds() or 0
                if idle_seconds <= 0:
                    schedule.run_pending()
                    continue
                if self.reload_requested():
                    break
                if self.run_requested_item_search():
                    self.handle_pause()
                    continue
                if self.rechecks.pending() and time.monotonic() >= self.recheck_after:
                    # A due search always runs first. Execute one listing, then check
                    # the schedule and configuration again before taking another.
                    self.process_recheck()
                    continue
                if self.image_matcher.automatic or self.image_matcher.queue.pending():
                    image_rows = load_matches(cache)
                    self.image_matcher.scan(image_rows)
                    if self.image_matcher.queue.pending():
                        image_job = self.image_matcher.process(image_rows)
                        if image_job and image_job["state"] in ("done", "stopped") and self.logger:
                            self.logger.info(
                                "Image matching %s",
                                image_job["state"],
                                extra=aimm_event(
                                    "image_matching_done", job_id=image_job["job_id"]
                                ),
                            )
                        continue
                    idle_seconds = min(idle_seconds, 60)
                if self.process_photo():
                    continue
                self.rechecks.wake.clear()
                if self.image_matcher.queue.pending() or self.requested_item_searches:
                    # A manual request can arrive between the earlier check and clear.
                    idle_seconds = min(idle_seconds, 1)
                if self.rechecks.pending():
                    idle_seconds = min(idle_seconds, max(1, self.recheck_after - time.monotonic()))
                if idle_seconds > 60:
                    # the sleep time might not be enough, causing this message
                    # to be sent repeatedly. Having a idle_seconds > 60 helps
                    # to reduce the frequency of this message.
                    if self.logger:
                        self.logger.info(
                            f"""{hilight("[Schedule]", "info")} Next job to search {hilight(str(next(iter(next_job.tags))))} scheduled to run in {humanize.naturaldelta(idle_seconds)} at {next_job.next_run.strftime("%Y-%m-%d %H:%M:%S")}"""
                        )

                # sleep at most 1 hr, and print updated "next job" message
                res = doze(
                    min(max(1, int(idle_seconds)), 60 * 60),
                    self.config_files,
                    self.keyboard_monitor,
                    self.rechecks.wake,
                )
                if self.reload_requested():
                    break
                if res == SleepStatus.BY_KEYBOARD:
                    self.keyboard_monitor.set_paused(True)

                self.handle_pause()
                schedule.run_pending()

    def reload_requested(self: "MarketplaceMonitor") -> bool:
        """Clear the schedule when the config changed or a search was requested."""
        if (
            calculate_file_hash(self.config_files) == self.config_hash
            and not self.search_requested.is_set()
        ):
            return False
        self.search_requested.clear()
        if self.logger:
            self.logger.info(
                f"""{hilight("[Config]", "info")} Reloading configuration and running enabled searches."""
            )
        schedule.clear()
        return True

    def process_photo(self) -> bool:
        """Backfill and capture one photo between searches, without AI or notification I/O."""
        result = archive_next_photo(cache, self.photo_attempts)
        if result and self.logger:
            self.logger.info(
                "Photo archived" if result["saved"] else "Photo unavailable: %s",
                *([] if result["saved"] else [result.get("reason", "Unknown error")]),
                extra=aimm_event(
                    "match_photo_saved" if result["saved"] else "match_photo_failed", **result
                ),
            )
        return result is not None

    def retry_photos(self, marketplace: str, listing_id: str) -> None:
        """Allow another archive attempt after fresh listing details arrive."""
        self.photo_attempts = {
            key for key in self.photo_attempts if key[:2] != (marketplace, listing_id)
        }

    def process_recheck(self) -> None:
        """Execute at most one queued listing, on the synchronous monitor thread."""
        work = self.rechecks.take()
        if work is None:
            return
        job_id, identity, target, refresh = work
        originals = load_matches(cache, identity["marketplace"], identity["listing_id"])
        original = next(
            (row for row in originals if row["item"] == identity.get("original_item")), None
        )
        original = original or next(iter(sorted(originals, key=lambda row: row["found_at"])), None)
        if original is not None and original["source"] == "manual" and target is None:
            self.process_manual_listing(job_id, original, refresh)
            return
        item = target or (original["item"] if original else "")
        result: dict[str, Any] = dict(
            **identity,
            item=item,
            status="error",
            score=None,
            old_score=original["score"] if original else None,
            old_price=(original["current_price"] or original["price"]) if original else None,
            reason="",
            at=datetime.now().isoformat(timespec="seconds"),
        )
        listing = None
        rating = None
        try:
            assert self.config is not None
            if original is None:
                raise ValueError("This match is no longer in the library")
            item_config = self.config.item.get(item)
            if item_config is None or item_config.enabled is False:
                raise ValueError("The saved search is missing or disabled")
            market_name = item_config.marketplace or identity["marketplace"]
            marketplace_config = self.config.marketplace.get(market_name)
            marketplace = self.active_marketplaces.get(market_name)
            if (
                marketplace_config is None
                or marketplace_config.enabled is False
                or marketplace is None
            ):
                raise ValueError("The marketplace is not active")
            if (marketplace_config.market_type or "facebook") != "facebook":
                raise ValueError("Re-check is only available for Facebook listings")
            listing, from_cache = marketplace.get_listing_details(
                f"https://www.facebook.com/marketplace/item/{identity['listing_id']}/",
                item_config,
                force_refresh=refresh,
            )
            result["fresh_details"] = not from_cache
            listing.name = item
            listing.marketplace = identity["marketplace"]
            result["price"] = listing.price
            price_reason = price_filter_reason(listing.price, item_config, marketplace_config)
            if price_reason:
                result.update(status="filtered_out", reason=price_reason)
            elif not marketplace.check_listing(listing, item_config):
                result.update(
                    status="filtered_out",
                    reason="Does not pass the current keyword, location or seller filters",
                )
            else:
                rating = self.evaluate_by_ai(listing, item_config, marketplace_config)
                threshold = (item_config.rating or marketplace_config.rating or [3])[
                    0 if item_config.searched_count == 0 else -1
                ]
                result.update(
                    rating_fields(rating),
                    threshold=threshold,
                    status="passed" if rating.score >= threshold else "below_threshold",
                )
        except Exception as error:
            # Browser/AI exceptions can contain credentials or URLs with tokens.
            # Detailed diagnostics belong to the existing redacted log stream.
            result.update(
                status="error",
                reason=f"Could not re-check ({type(error).__name__}). Check the monitor activity and browser login.",
            )
        if original is not None:
            record_recheck(cache, original, result, listing, rating)
            self.retry_photos(identity["marketplace"], identity["listing_id"])
        if listing is not None and original is not None:
            # The detail cache is shared with legacy CSV joins. A check against
            # another search must not relabel its original search in that cache.
            listing.name = original["item"]
            listing.to_cache(listing.post_url, cache)
        job = self.rechecks.finish(job_id, result)
        self.recheck_after = time.monotonic() + random.uniform(5, 15)
        if self.logger:
            self.logger.info(
                "Re-check %s: %s",
                identity["listing_id"],
                result["status"],
                extra=aimm_event("recheck_result", job_id=job_id, **result),
            )
            if job["state"] in ("done", "stopped"):
                counts = {
                    name: sum(row["status"] == name for row in job["results"])
                    for name in (
                        "passed",
                        "below_threshold",
                        "filtered_out",
                        "unavailable",
                        "error",
                    )
                }
                self.logger.info(
                    "Re-check %s",
                    job["state"],
                    extra=aimm_event("recheck_done", job_id=job_id, counts=counts),
                )

    def process_manual_listing(self, job_id: str, original: dict[str, Any], refresh: bool) -> None:
        """Fetch and assess on the monitor thread; persist details before calling AI."""
        listing = Listing(
            marketplace=original["marketplace"],
            name="",
            id=original["listing_id"],
            title=original["title"],
            image=original["image"],
            price=original["current_price"] or "",
            post_url=original["url"],
            location=original["location"],
            seller=original["seller"],
            condition=original["condition"],
            description=original["description"],
        )
        result: dict[str, Any] = {
            "marketplace": listing.marketplace,
            "listing_id": listing.id,
            "item": "",
            "original_item": "",
            "status": "error",
            "reason": "",
            "at": datetime.now().isoformat(timespec="seconds"),
        }
        try:
            assert self.config is not None
            market_name = next(
                name
                for name, config in self.config.marketplace.items()
                if (config.market_type or "facebook") == "facebook"
                and config.enabled is not False
                and name in self.active_marketplaces
            )
            marketplace_config = self.config.marketplace[market_name]
            item_config = general_assessment_config()
            cached = Listing.from_cache(listing.post_url, cache)
            listing, from_cache = self.active_marketplaces[market_name].get_listing_details(
                listing.post_url,
                item_config,
                force_refresh=refresh,
            )
            # Keep legacy notification/CSV attribution when a saved search also found it.
            listing.name = cached.name if cached is not None else ""
            listing.marketplace = original["marketplace"]
            listing.id = original["listing_id"]
            listing.to_cache(listing.post_url, cache)
            result.update(price=listing.price, fresh_details=not from_cache)
            record_manual_listing(cache, listing)
            rating = self.evaluate_by_ai(listing, item_config, marketplace_config)
            if rating.comment == AIResponse.NOT_EVALUATED:
                raise ValueError("AI assessment unavailable")
            record_manual_listing(cache, listing, rating, "assessed")
            result.update(status="assessed", **rating_fields(rating))
        except Exception as error:
            result["reason"] = (
                f"Could not fetch or assess ({type(error).__name__}). "
                "Check the monitor activity, browser login and AI settings, then retry."
            )
            record_manual_listing(cache, listing, status="error", reason=result["reason"])
        self.retry_photos(listing.marketplace, listing.id)
        self.rechecks.finish(job_id, result)
        self.recheck_after = time.monotonic() + random.uniform(5, 15)
        if self.logger:
            self.logger.info(
                "Manual listing %s: %s",
                listing.id,
                result["status"],
                extra=aimm_event("manual_listing_result", job_id=job_id, **result),
            )

    def stop_monitor(self: "MarketplaceMonitor") -> None:
        """Stop the monitor."""
        for marketplace in self.active_marketplaces.values():
            marketplace.stop()
        self.playwright.stop()
        if self.keyboard_monitor:
            self.keyboard_monitor.stop()
        cache.close()

    def check_items(
        self: "MarketplaceMonitor", items: List[str] | None = None, for_item: str | None = None
    ) -> None:
        """Main function to monitor the marketplace."""
        # we reload the config file each time when a scan action is completed
        # this allows users to add/remove products dynamically.
        self.load_config_file()

        if for_item is not None:
            assert self.config is not None
            if for_item not in self.config.item:
                raise ValueError(
                    f"Item {for_item} not found in config, available items are {', '.join(self.config.item.keys())}."
                )

        self.load_ai_agents()

        post_urls = []
        for post_url in items or []:
            if post_url.isnumeric():
                post_url = f"https://www.facebook.com/marketplace/item/{post_url}/"

            if not post_url.startswith("https://www.facebook.com/marketplace/item"):
                raise ValueError(f"URL {post_url} is not a valid Facebook Marketplace URL.")
            post_urls.append(post_url)

        if not post_urls:
            raise ValueError("No URLs to check.")

        # Open a new browser page.
        for post_url in post_urls or []:
            # check if item in config
            assert self.config is not None

            # which marketplace to check it?
            for marketplace_config in self.config.marketplace.values():
                if marketplace_config.enabled is False:
                    continue
                marketplace_class = supported_marketplaces[marketplace_config.name]
                if marketplace_config.name in self.active_marketplaces:
                    marketplace = self.active_marketplaces[marketplace_config.name]
                else:
                    marketplace = marketplace_class(
                        marketplace_config.name, None, None, self.logger
                    )
                    self.active_marketplaces[marketplace_config.name] = marketplace

                # Configure might have been changed
                marketplace.configure(
                    marketplace_config,
                    translator=self._select_translator(marketplace_config.language),
                )

                # do we need a browser?
                if Listing.from_cache(post_url) is None:
                    if self.browser is None:
                        if self.logger:
                            self.logger.info(
                                f"""{hilight("[Search]", "info")} Starting a browser because the item was not checked before."""
                            )
                        self.browser = self._launch_browser()
                        marketplace.set_browser(self.browser)

                # ignore enabled
                if for_item is None:
                    # get by asking user
                    name = None
                    item_names = list(self.config.item.keys())
                    if len(item_names) > 1:
                        name = Prompt.ask(
                            f"""Enter name of {hilight("search item")}""", choices=item_names
                        )
                    item_config = self.config.item[name or item_names[0]]
                else:
                    item_config = self.config.item[for_item]

                # do not search, get the item details directly
                listing_result = marketplace.get_listing_details(post_url, item_config)

                # get_listing_details returns a tuple (Listing, bool) - unpack it properly
                if isinstance(listing_result, tuple) and len(listing_result) == 2:
                    listing, _from_cache = listing_result
                else:
                    # Fallback - treat as direct listing (shouldn't happen but defensive)
                    listing = listing_result

                if self.logger:
                    self.logger.info(
                        f"""{hilight("[Retrieve]", "succ")} Details of the item is found: {pretty_repr(listing)}"""
                    )

                if self.logger:
                    self.logger.info(
                        f"""{hilight("[Search]", "succ")} Checking {post_url} for item {item_config.name} with configuration {pretty_repr(item_config)}"""
                    )
                marketplace.check_listing(listing, item_config)
                rating = self.evaluate_by_ai(
                    listing, item_config=item_config, marketplace_config=marketplace_config
                )
                if self.logger:
                    if rating.comment == AIResponse.NOT_EVALUATED:
                        if rating.name:
                            self.logger.info(
                                f"""{hilight("[AI]", rating.style)} {rating.name or "AI"} did not evaluate {hilight(listing.title)}."""
                            )
                        else:
                            self.logger.info(
                                f"""{hilight("[AI]", rating.style)} No AI available to evaluate {hilight(listing.title)}."""
                            )
                    else:
                        self.logger.info(
                            f"""{hilight("[AI]", rating.style)} {rating.name or "AI"} concludes {hilight(f"{rating.conclusion} ({rating.score}): {rating.comment}", rating.style)} for listing {hilight(listing.title)}."""
                        )
                # notification status?
                users_to_notify = (
                    item_config.notify
                    or marketplace_config.notify
                    or list(self.config.user.keys())
                )
                # for notification usages
                listing.name = item_config.name
                for user in users_to_notify:
                    ns = User(self.config.user[user], self.logger).notification_status(listing)
                    if self.logger:
                        if ns == NotificationStatus.NOTIFIED:
                            self.logger.info(
                                f"""{hilight("[Notify]", "succ")} Notified {user} about {post_url}."""
                            )
                        elif ns == NotificationStatus.EXPIRED:
                            self.logger.info(
                                f"""{hilight("[Notify]", "info")} Already notified {user} about {post_url}. The notification is ow expired."""
                            )
                        elif ns == NotificationStatus.LISTING_CHANGED:
                            self.logger.info(
                                f"""{hilight("[Notify]", "info")} Already notified {user} about {post_url}, but the listing is now changed."""
                            )
                        elif ns == NotificationStatus.LISTING_DISCOUNTED:
                            self.logger.info(
                                f"""{hilight("[Notify]", "info")} Already notified {user} about {post_url}, but the listing is now discounted."""
                            )
                        else:
                            self.logger.info(
                                f"""{hilight("[Notify]", "info")} Not notified {user} about {post_url} yet."""
                            )

                    # testing notification
                    # User(self.config.user[user], logger=self.logger).notify(
                    #     [listing], [rating], item_config, force=True
                    # )

    def evaluate_by_ai(
        self: "MarketplaceMonitor",
        item: Listing,
        item_config: TItemConfig,
        marketplace_config: TMarketplaceConfig,
    ) -> AIResponse:
        if item_config.ai is not None:
            ai_agents = item_config.ai
        elif marketplace_config.ai is not None:
            ai_agents = marketplace_config.ai
        else:
            ai_agents = None
        #
        for agent in self.ai_agents:
            if ai_agents is not None and agent.config.name not in ai_agents:
                continue
            try:
                return agent.evaluate(item, item_config, marketplace_config)
            except KeyboardInterrupt:
                raise
            except Exception as e:
                if self.logger:
                    self.logger.error(
                        f"""{hilight("[AI]", "fail")} Failed to get an answer from {agent.config.name}: {e}"""
                    )
                continue
        assert self.config is not None
        if any(
            ai_config.enabled is not False and (ai_agents is None or ai_config.name in ai_agents)
            for ai_config in (self.config.ai or {}).values()
        ):
            raise AIUnavailableError("No configured AI service evaluated the listing")
        return AIResponse(5, AIResponse.NOT_EVALUATED)
