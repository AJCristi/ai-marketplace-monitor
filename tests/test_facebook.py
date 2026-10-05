import time
from pathlib import Path

import pytest
from pytest_playwright.pytest_playwright import CreateContextCallback  # type: ignore

from ai_marketplace_monitor.facebook import (
    FacebookAutoItemWithDescriptionPage,
    FacebookSearchResultPage,
    parse_listing,
)


def test_search_page(
    new_context: CreateContextCallback, filename: str = "search_result_1.html"
) -> None:
    local_file_path = Path(__file__).parent / filename
    page = new_context(java_script_enabled=False).new_page()
    page.goto(f"file://{local_file_path}")

    for _ in range(10):
        p = FacebookSearchResultPage(page)
        page.wait_for_load_state("domcontentloaded")
        listings = p.get_listings()
        if len(listings) != 0:
            break
        time.sleep(1)

    for idx, listing in enumerate(listings):
        assert listing.marketplace == "facebook"
        assert listing.id.isnumeric(), f"wrong id for listing {idx + 1} with title {listing.title}"
        assert listing.title, f"No title is found {idx + 1} with title "
        assert listing.image, f"wrong image for listing {idx + 1} with title {listing.title}"
        assert listing.post_url, f"wrong post_url for listing {idx + 1} with title {listing.title}"
        assert listing.price, f"wrong price for listing {idx + 1} with title {listing.title}"
        if idx == 10:
            assert (
                listing.location == ""
            ), f"listing {idx + 1} with title {listing.title} has empty location"
        else:
            assert (
                listing.location
            ), f"wrong location for listing {idx + 1} with title {listing.title}"
        assert listing.seller == "", "Seller should be empty"

    assert len(listings) == 21


@pytest.mark.parametrize(
    "filename,price,seller,location,gallery_count",
    [
        ("regular_listing.html", "$10", "Austin Ewing", "MS", 1),
        ("rental_listing.html", "$150", "Perry Burton", "Houston, TX", 5),
        (
            "auto_with_about_and_description_listing.html",
            "**unspecified**",
            "Lily Ortiz",
            "Houston, TX",
            17,
        ),
        ("auto_with_description_listing.html", "€6,695", "Abdel Abdel", "Bergen op Zoom, NB", 10),
    ],
)
def test_listing_page(
    new_context: CreateContextCallback,
    filename: str,
    price: str,
    seller: str,
    location: str,
    gallery_count: int,
) -> None:
    local_file_path = Path(__file__).parent / filename

    page = new_context(java_script_enabled=False).new_page()
    page.goto(f"file://{local_file_path}")
    page.wait_for_load_state("domcontentloaded")
    # Saved HTML uses local image paths. Restore CDN-shaped URLs without any network I/O.
    page.route("https://scontent.fbcdn.net/**", lambda route: route.abort())
    page.locator("img").evaluate_all(
        """images => images.forEach(image => {
        const path = new URL(image.src).pathname.split('/').pop();
        image.removeAttribute('srcset');
        image.src = 'https://scontent.fbcdn.net/' + path;
    })"""
    )
    page.wait_for_function(
        "Array.from(document.images).every(image => !image.currentSrc || image.currentSrc.startsWith('https://scontent.fbcdn.net/'))"
    )
    listing = parse_listing(page, "post_url", None)

    assert listing is not None, f"Should be able to parse {filename}"
    assert listing.title, f"Title of {filename} should be {listing.title}"
    assert listing.price == price, f"Price of {filename} should be {listing.price}"
    assert listing.location == location, f"Location of {filename} should be {listing.location}"
    assert listing.seller == seller, f"Seller of {filename} should be {listing.seller}"
    assert len(listing.image_urls) == gallery_count
    assert listing.image_urls[0] == listing.image
    assert listing.image, f"Image of {filename} should not be empty"
    assert listing.post_url, f"post_url of {filename} should not be empty"


@pytest.mark.parametrize(
    "detail,body,condition",
    [
        (
            "<span>Condition</span><span>Used - Good</span>",
            "Motorcycle for sale. Complete papers.",
            "Used - Good",
        ),
        ("Well maintained motorcycle, serviced regularly.", "", "**unspecified**"),
    ],
)
def test_vehicle_condition_requires_label(
    new_context: CreateContextCallback, detail: str, body: str, condition: str
) -> None:
    page = new_context(java_script_enabled=False).new_page()
    page.set_content(
        "<section><h2><span>Seller's description</span></h2><div><div>"
        f"<div>{detail}</div><div>{body}</div>"
        "<div>See translation</div></div></div></section>"
    )
    listing = FacebookAutoItemWithDescriptionPage(page)
    assert listing.get_condition() == condition
    if condition == "**unspecified**":
        assert detail in listing.get_description()
    else:
        assert body in listing.get_description()
