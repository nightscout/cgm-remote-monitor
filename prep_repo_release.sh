#!/bin/bash
set -ueE

function update ( ) {
  upgrade=$1
  npm version $upgrade || exit 255
}

RELEASE_NOTES="Release.md"
TYPE=${1-'patch'}
echo "First update"

npm ls . || echo -n ""
NEW_TAG=$(update ${TYPE})
echo "Updating to $NEW_TAG"
# npm commits a new package json on your behalf with a new tag pointed at it
git reset --hard HEAD~1
git tag -d $NEW_TAG || echo "warning ${NEW_TAG} not present"
BRANCH_NAME="release/${NEW_TAG}"
git checkout -b ${BRANCH_NAME}
npm ls . || echo -n ""
cat /dev/null > ${RELEASE_NOTES}
git changelog -t ${NEW_TAG} ${RELEASE_NOTES}
echo "saving release notes"
git add ${RELEASE_NOTES}
git commit -vm "Release notes for ${NEW_TAG}"

echo "Final update"
update ${TYPE}
echo "New version $NEW_TAG"
echo "Branch ${BRANCH_NAME}"
npm ls . || echo -n ""

