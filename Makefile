build:
	earthly +buildImage

run:
	docker compose up -d

push:
	earthly --push +buildImage
