.PHONY: all help fmt fmt-prettier fmt-clang serve

# Code formatting files
JS_HTML_CSS_FILES := $(wildcard *.js *.html *.css)
GLSL_FILES        := $(wildcard *.glsl)

# Default target when running `make`
all: help

# ==============================================================================
# CODE FORMATTING
# ==============================================================================

## fmt           : Format JS, HTML, CSS, and GLSL source files
fmt: fmt-prettier fmt-clang

fmt-prettier:
	prettier --write $(JS_HTML_CSS_FILES)

fmt-clang:
	clang-format -i $(GLSL_FILES)

# ==============================================================================
# SERVER
# ==============================================================================

## serve         : Run Node.js HTTP server with COOP/COEP headers
serve:
	node server.js

# ==============================================================================
# UTILITIES
# ==============================================================================

## help          : Display available targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed -e 's/## //'
